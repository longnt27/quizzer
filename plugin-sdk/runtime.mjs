import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { runningAsSingleExecutable } from '../server/runtime-assets.mjs';
import { validatePluginPath } from './manifest.mjs';

const retainedEnvironment = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'];

const pluginEnvironment = ({ manifest, temporaryDirectory, secrets }) => {
  const environment = {
    QUIZZER_PLUGIN_ID: manifest.id,
    QUIZZER_PLUGIN_TEMP_DIR: temporaryDirectory,
    QUIZZER_PLUGIN_NETWORK: JSON.stringify(manifest.permissions.network),
    QUIZZER_PLUGIN_FILESYSTEM: JSON.stringify(manifest.permissions.filesystem),
    ELECTRON_RUN_AS_NODE: '1',
    NO_COLOR: '1',
  };
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

const materializeScopedFiles = async (temporaryDirectory, manifest, files) => {
  if (!Array.isArray(files) || files.length > 30) throw new Error('Plugin scoped files must be an array of at most 30 items');
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
    if (data.length > 20 * 1024 * 1024) throw new Error(`Plugin scoped file exceeds 20 MB: ${path}`);
    totalBytes += data.length;
    if (totalBytes > 100 * 1024 * 1024) throw new Error('Plugin scoped files exceed the 100 MB invocation limit');
    const destination = join(temporaryDirectory, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, data, { mode: 0o600, flag: 'wx' });
    prepared.push({ path, size: data.length });
  }
  return prepared;
};

export const invokePluginProcess = async ({
  appDataDirectory, directory, manifest, method, params = {}, configuration = {}, secrets = {}, signal,
  timeoutMs = 30_000, files = [],
}) => {
  if (typeof method !== 'string' || !method.trim()) throw new Error('Plugin method is required');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Plugin parameters must be an object');
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Plugin configuration must be an object');
  const temporaryRoot = join(appDataDirectory, 'plugin-temp');
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, `${manifest.id}-`));
  const entrypoint = join(directory, manifest.entrypoint);
  const javascript = /\.(?:c?js|mjs)$/i.test(entrypoint);
  const command = javascript ? await javascriptRuntime() : entrypoint;
  const arguments_ = javascript
    ? [`--max-old-space-size=${Math.max(16, manifest.resources.memoryMB)}`, entrypoint]
    : [];
  const requestId = randomUUID();
  const startedAt = Date.now();
  let child;
  try {
    const scopedFiles = await materializeScopedFiles(temporaryDirectory, manifest, files);
    return await new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let outcome;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve({ result, metrics: { durationMs: Date.now() - startedAt } });
      };
      const stop = (error, result) => {
        if (settled || outcome) return;
        outcome = { error, result };
        if (!child) return finish(error, result);
        child.kill('SIGTERM');
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
        env: pluginEnvironment({ manifest, temporaryDirectory, secrets }),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      signal?.addEventListener('abort', cancel, { once: true });
      child.on('error', error => finish(error));
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
        if (outcome) finish(outcome.error, outcome.result);
        else if (!settled) finish(new Error(stderr.trim() || `Plugin ${manifest.id} exited with code ${code} before responding`));
      });
      child.stdin.end(`${JSON.stringify({
        jsonrpc: '2.0', id: requestId, method, params,
        context: { temporaryDirectory, scopedFiles, configuration, protocolVersion: manifest.protocolVersion },
      })}\n`);
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
