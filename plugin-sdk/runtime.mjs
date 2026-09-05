import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

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

export const invokePluginProcess = async ({
  appDataDirectory, directory, manifest, method, params = {}, configuration = {}, secrets = {}, signal,
  timeoutMs = 30_000,
}) => {
  if (typeof method !== 'string' || !method.trim()) throw new Error('Plugin method is required');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Plugin parameters must be an object');
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Plugin configuration must be an object');
  const temporaryRoot = join(appDataDirectory, 'plugin-temp');
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, `${manifest.id}-`));
  const entrypoint = join(directory, manifest.entrypoint);
  const javascript = /\.(?:c?js|mjs)$/i.test(entrypoint);
  const command = javascript ? process.execPath : entrypoint;
  const arguments_ = javascript
    ? [`--max-old-space-size=${Math.max(16, manifest.resources.memoryMB)}`, entrypoint]
    : [];
  const requestId = randomUUID();
  const startedAt = Date.now();
  let child;
  try {
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
        context: { temporaryDirectory, configuration, protocolVersion: manifest.protocolVersion },
      })}\n`);
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
