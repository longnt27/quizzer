import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { terminateChild } from '../server/process-control.mjs';
import { runningAsSingleExecutable } from '../server/runtime-assets.mjs';
import { validatePluginPath } from './manifest.mjs';

const retainedEnvironment = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'];
const resourceSampleIntervalMs = 250;

const boundedCommandOutput = (command, arguments_) => new Promise((resolve, reject) => {
  const child = spawn(command, arguments_, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let output = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
  timer.unref?.();
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 4_096) child.kill('SIGKILL');
  });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => {
    clearTimeout(timer);
    if (code === 0) resolve(output.trim());
    else reject(new Error(`Resource monitor exited with code ${code}`));
  });
});

const residentBytesFor = async pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1_024 : undefined;
  }
  if (process.platform === 'darwin') {
    const output = await boundedCommandOutput('/bin/ps', ['-o', 'rss=', '-p', String(pid)]);
    const kilobytes = Number(output);
    return Number.isFinite(kilobytes) && kilobytes >= 0 ? Math.round(kilobytes * 1_024) : undefined;
  }
  if (process.platform === 'win32') {
    const powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const output = await boundedCommandOutput(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
    ]);
    const bytes = Number(output);
    return Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : undefined;
  }
  return undefined;
};

const monitorPluginProcess = pid => {
  let peakRssBytes;
  let sampleCount = 0;
  let pending;
  const sample = () => {
    if (pending) return pending;
    pending = residentBytesFor(pid)
      .then(bytes => {
        if (bytes === undefined) return;
        peakRssBytes = Math.max(peakRssBytes ?? 0, bytes);
        sampleCount += 1;
      })
      .catch(() => {})
      .finally(() => { pending = undefined; });
    return pending;
  };
  void sample();
  const timer = setInterval(() => void sample(), resourceSampleIntervalMs);
  timer.unref?.();
  return {
    sample,
    finish: async () => {
      clearInterval(timer);
      if (pending) await pending;
      return {
        resourceSamples: sampleCount,
        ...(peakRssBytes === undefined ? {} : { peakRssBytes }),
      };
    },
  };
};

const terminatePluginProcess = (child, signal) => {
  if (process.platform !== 'win32' && Number.isSafeInteger(child?.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* Fall back to the direct child if its process group already exited. */ }
  }
  terminateChild(child, signal);
};

const pluginEnvironment = ({ manifest, temporaryDirectory, persistentDataDirectory, secrets }) => {
  const environment = {
    QUIZZER_PLUGIN_ID: manifest.id,
    QUIZZER_PLUGIN_TEMP_DIR: temporaryDirectory,
    QUIZZER_PLUGIN_NETWORK: JSON.stringify(manifest.permissions.network),
    QUIZZER_PLUGIN_FILESYSTEM: JSON.stringify(manifest.permissions.filesystem),
    ELECTRON_RUN_AS_NODE: '1',
    NO_COLOR: '1',
  };
  if (persistentDataDirectory) environment.QUIZZER_PLUGIN_DATA_DIR = persistentDataDirectory;
  for (const key of retainedEnvironment) if (process.env[key]) environment[key] = process.env[key];
  for (const key of manifest.permissions.secrets) {
    if (typeof secrets?.[key] === 'string') environment[key] = secrets[key];
  }
  return environment;
};

const availableExecutable = async path => {
  if (!path) return false;
  try { await access(path, constants.X_OK); return true; }
  catch { return false; }
};

const javascriptRuntime = async () => {
  if (!runningAsSingleExecutable) return process.execPath;
  const candidates = [process.env.QUIZZER_NODE_RUNTIME];
  if (process.platform === 'darwin') candidates.push(join(homedir(), 'Applications', 'Quizzer.app', 'Contents', 'MacOS', 'Quizzer'));
  if (process.platform === 'linux') candidates.push(join(homedir(), '.local', 'share', 'quizzer', 'app', 'quizzer'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'quizzer', 'quizzer.exe'), join(process.env.LOCALAPPDATA, 'quizzer', 'Quizzer.exe'));
  }
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  candidates.push(...String(process.env.PATH || '').split(delimiter).filter(Boolean).map(path => join(path, nodeName)));
  for (const candidate of candidates) if (await availableExecutable(candidate)) return candidate;
  throw new Error('JavaScript plugins require the Quizzer desktop app, QUIZZER_NODE_RUNTIME, or a Node.js executable on PATH');
};

const materializeScopedFiles = async (temporaryDirectory, manifest, files, limits = {}) => {
  const maximumFiles = limits.maximumFiles ?? 30;
  const maximumFileBytes = limits.maximumFileBytes ?? 20 * 1024 * 1024;
  const maximumTotalBytes = limits.maximumTotalBytes ?? 100 * 1024 * 1024;
  if (![maximumFiles, maximumFileBytes, maximumTotalBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || maximumFiles > 100 || maximumFileBytes > 250 * 1024 * 1024 || maximumTotalBytes > 500 * 1024 * 1024) {
    throw new Error('Plugin scoped file limits are invalid');
  }
  if (!Array.isArray(files) || files.length > maximumFiles) {
    throw new Error(`Plugin scoped files must be an array of at most ${maximumFiles} items`);
  }
  if (files.length && !manifest.permissions.filesystem.includes('scoped-temp')) {
    throw new Error(`Plugin ${manifest.id} must declare scoped-temp permission to receive files`);
  }
  let totalBytes = 0;
  const seen = new Set();
  const prepared = [];
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Plugin scoped file is invalid');
    const path = validatePluginPath(file.path);
    if (seen.has(path)) throw new Error(`Duplicate plugin scoped file: ${path}`);
    seen.add(path);
    if (!(typeof file.data === 'string' || Buffer.isBuffer(file.data) || ArrayBuffer.isView(file.data))) {
      throw new Error(`Plugin scoped file data is invalid: ${path}`);
    }
    const data = Buffer.isBuffer(file.data) ? file.data
      : typeof file.data === 'string' ? Buffer.from(file.data) : Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
    if (data.length > maximumFileBytes) throw new Error(`Plugin scoped file exceeds ${maximumFileBytes} bytes: ${path}`);
    totalBytes += data.length;
    if (totalBytes > maximumTotalBytes) throw new Error(`Plugin scoped files exceed the ${maximumTotalBytes}-byte invocation limit`);
    const destination = join(temporaryDirectory, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, data, { mode: 0o600, flag: 'wx' });
    prepared.push({ path, size: data.length });
  }
  return prepared;
};

export const invokePluginProcess = async ({
  appDataDirectory, directory, manifest, method, params = {}, configuration = {}, secrets = {}, signal,
  timeoutMs = 30_000, files = [], fileLimits,
}) => {
  if (typeof method !== 'string' || !method.trim()) throw new Error('Plugin method is required');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Plugin parameters must be an object');
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Plugin configuration must be an object');
  const temporaryRoot = join(appDataDirectory, 'plugin-temp');
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, `${manifest.id}-`));
  const persistentDataDirectory = manifest.permissions.filesystem.includes('persistent-data')
    ? join(appDataDirectory, 'plugins', 'data', manifest.id)
    : undefined;
  if (persistentDataDirectory) await mkdir(persistentDataDirectory, { recursive: true, mode: 0o700 });
  const entrypoint = join(directory, manifest.entrypoint);
  const javascript = /\.(?:c?js|mjs)$/i.test(entrypoint);
  const command = javascript ? await javascriptRuntime() : entrypoint;
  const arguments_ = javascript
    ? [`--max-old-space-size=${Math.max(16, manifest.resources.memoryMB)}`, entrypoint]
    : [];
  const requestId = randomUUID();
  const startedAt = Date.now();
  let child;
  let resourceMonitor;
  try {
    const scopedFiles = await materializeScopedFiles(temporaryDirectory, manifest, files, fileLimits);
    return await new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let outcome;
      let forceKillTimer;
      const finish = async (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceKillTimer);
        signal?.removeEventListener('abort', cancel);
        const observed = await resourceMonitor?.finish() ?? { resourceSamples: 0 };
        const metrics = {
          durationMs: Date.now() - startedAt,
          declaredMemoryMB: manifest.resources.memoryMB,
          scopedFileBytes: scopedFiles.reduce((sum, file) => sum + file.size, 0),
          ...observed,
        };
        if (error) {
          if (error && typeof error === 'object' && Object.isExtensible(error)) error.pluginMetrics = metrics;
          reject(error);
        } else resolve({ result, metrics });
      };
      const stop = (error, result) => {
        if (settled || outcome) return;
        outcome = { error, result };
        if (!child) { void finish(error, result); return; }
        void resourceMonitor?.sample().finally(() => {
          if (settled) return;
          terminatePluginProcess(child, 'SIGTERM');
          forceKillTimer = setTimeout(() => {
            if (!settled) terminatePluginProcess(child, 'SIGKILL');
          }, 1_000);
          forceKillTimer.unref?.();
        });
      };
      const cancel = () => {
        stop(Object.assign(new Error('Plugin invocation cancelled'), { name: 'AbortError' }));
      };
      const timer = setTimeout(() => {
        stop(new Error(`Plugin ${manifest.id} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      if (signal?.aborted) return cancel();

      child = spawn(command, arguments_, {
        cwd: directory,
        env: pluginEnvironment({ manifest, temporaryDirectory, persistentDataDirectory, secrets }),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      resourceMonitor = monitorPluginProcess(child.pid);
      signal?.addEventListener('abort', cancel, { once: true });
      child.on('error', error => void finish(error));
      child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-131_072); });
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 10 * 1024 * 1024) {
          stop(new Error(`Plugin ${manifest.id} exceeded the output limit`));
          return;
        }
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          let response;
          try { response = JSON.parse(line); }
          catch { continue; }
          if (response.jsonrpc !== '2.0' || response.id !== requestId) continue;
          if (response.error) stop(new Error(response.error.message || `Plugin ${manifest.id} failed`));
          else stop(undefined, response.result);
        }
      });
      child.on('close', code => {
        if (outcome) void finish(outcome.error, outcome.result);
        else if (!settled) void finish(new Error(stderr.trim() || `Plugin ${manifest.id} exited with code ${code} before responding`));
      });
      child.stdin.end(`${JSON.stringify({
        jsonrpc: '2.0', id: requestId, method, params,
        context: {
          temporaryDirectory,
          scopedFiles,
          ...(persistentDataDirectory ? { persistentDataDirectory } : {}),
          configuration,
          protocolVersion: manifest.protocolVersion,
        },
      })}\n`);
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
