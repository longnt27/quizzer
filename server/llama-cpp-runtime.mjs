import { lstat, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { getLlamaCppStatus } from './llama-cpp-generation.mjs';

export const LLAMA_CPP_RUNTIME_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  contextSize: 4096,
  batchSize: 512,
  threads: 4,
  startupTimeoutMs: 15_000,
  stopTimeoutMs: 2_000,
});

const MAX_PATH_LENGTH = 4_096;
const MAX_OUTPUT_LENGTH = 12_000;
const MAX_ERROR_LENGTH = 1_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const PATH_LIKE = /(?:[A-Za-z]:[\\/]|\/|\\\\)[^\s'"`]+/g;

const bounded = (value, limit = MAX_ERROR_LENGTH) => String(value ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(-limit);
const safeMessage = (value, fallback = 'llama.cpp runtime failed') => bounded(value, MAX_ERROR_LENGTH) || fallback;

export const redactRuntimeOutput = (value, paths = []) => {
  let result = bounded(value, MAX_OUTPUT_LENGTH);
  for (const path of paths.filter(Boolean)) result = result.split(path).join(`[${basename(path)}]`);
  return result.replace(PATH_LIKE, match => `[${basename(match.replaceAll('\\', '/'))}]`).slice(-MAX_OUTPUT_LENGTH);
};

export const validateRuntimePath = async (value, label, { executable = false, statImpl = lstat } = {}) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const path = value.trim();
  if (path.length > MAX_PATH_LENGTH || CONTROL_CHARS.test(path) || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path without control characters (maximum ${MAX_PATH_LENGTH} characters)`);
  }
  CONTROL_CHARS.lastIndex = 0;
  let details;
  try { details = await statImpl(path); }
  catch { throw new Error(`${label} must point to an existing regular file`); }
  if (details.isSymbolicLink?.()) throw new Error(`${label} must not be a symbolic link`);
  if (!details.isFile?.()) throw new Error(`${label} must point to an existing regular file`);
  if (executable && process.platform !== 'win32' && (Number(details.mode) & 0o111) === 0) {
    throw new Error(`${label} must be executable`);
  }
  return path;
};

export const validateRuntimeOptions = (options = {}) => {
  const numeric = (key, min, max) => {
    const value = options[key] ?? LLAMA_CPP_RUNTIME_DEFAULTS[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return value;
  };
  if (options.host !== undefined && options.host !== LLAMA_CPP_RUNTIME_DEFAULTS.host) throw new Error('llama.cpp managed runtime only supports 127.0.0.1');
  return {
    host: LLAMA_CPP_RUNTIME_DEFAULTS.host,
    port: numeric('port', 1024, 65_535),
    contextSize: numeric('contextSize', 512, 131_072),
    batchSize: numeric('batchSize', 1, 2_048),
    threads: numeric('threads', 1, 256),
    startupTimeoutMs: numeric('startupTimeoutMs', 1_000, 120_000),
    stopTimeoutMs: numeric('stopTimeoutMs', 250, 30_000),
  };
};

const runtimeStatus = (status = {}) => ({
  mode: status.mode === 'managed' ? 'managed' : 'manual',
  state: ['idle', 'starting', 'running', 'stopping', 'error'].includes(status.state) ? status.state : 'idle',
  configured: Boolean(status.configured),
  serverReady: Boolean(status.serverReady),
  host: '127.0.0.1',
  port: Number.isSafeInteger(status.port) && status.port >= 1024 && status.port <= 65_535 ? status.port : LLAMA_CPP_RUNTIME_DEFAULTS.port,
  executableName: typeof status.executableName === 'string' ? basename(status.executableName).slice(-160) : undefined,
  modelName: typeof status.modelName === 'string' ? basename(status.modelName).slice(-160) : undefined,
  pid: Number.isSafeInteger(status.pid) ? status.pid : undefined,
  startedAt: Number.isSafeInteger(status.startedAt) ? status.startedAt : undefined,
  stoppedAt: Number.isSafeInteger(status.stoppedAt) ? status.stoppedAt : undefined,
  lastError: status.lastError ? safeMessage(status.lastError) : undefined,
  output: status.output ? redactRuntimeOutput(status.output) : undefined,
});

const persistStatus = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(runtimeStatus(value), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const readStatus = async path => {
  try { return runtimeStatus(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error?.code !== 'ENOENT') return runtimeStatus({ state: 'error', lastError: 'Saved llama.cpp runtime status is invalid' }); return runtimeStatus(); }
};

const signalError = reason => reason instanceof Error ? reason : Object.assign(new Error(String(reason || 'Operation cancelled')), { name: 'AbortError' });

export const createLlamaCppRuntime = ({
  appDataDirectory,
  statusPath = `${appDataDirectory}/llama-cpp-runtime.json`,
  loadSettings,
  saveSettings,
  detectHardware = () => ({ cpuCores: 4, memoryGB: 8 }),
  spawn = nodeSpawn,
  healthCheck = ({ endpoint }, signal) => getLlamaCppStatus({ endpoint }, globalThis.fetch, signal),
  now = () => Date.now(),
} = {}) => {
  if (typeof loadSettings !== 'function' || typeof saveSettings !== 'function') throw new Error('llama.cpp runtime requires settings storage');
  let status = runtimeStatus();
  let child;
  let activeStart;
  let initialized = false;

  const save = async next => { status = runtimeStatus(next); await persistStatus(statusPath, status); return status; };
  const initialize = async () => {
    if (!initialized) { status = await readStatus(statusPath); if (status.state === 'starting' || status.state === 'stopping' || status.state === 'running') status = await save({ ...status, state: 'idle', serverReady: false, pid: undefined, lastError: status.state === 'running' ? 'Managed process was not running after service restart' : undefined }); initialized = true; }
    return status;
  };
  const currentSettings = async () => (await loadSettings()).values ?? await loadSettings();
  const settingsForStart = async () => {
    const values = await currentSettings();
    const executablePath = values['providers.llama-cpp.executablePath'];
    const modelPath = values['providers.llama-cpp.modelPath'];
    if (!executablePath || !modelPath) throw new Error('Select an installed llama.cpp executable and model file before starting the managed runtime');
    const hardware = detectHardware() || {};
    const options = validateRuntimeOptions({
      port: values['providers.llama-cpp.managedPort'],
      contextSize: values['providers.llama-cpp.contextSize'],
      batchSize: values['providers.llama-cpp.batchSize'],
      threads: Math.min(values['providers.llama-cpp.threads'] ?? LLAMA_CPP_RUNTIME_DEFAULTS.threads, Math.max(1, Number(hardware.cpuCores) || 1)),
    });
    return { values, executablePath: await validateRuntimePath(executablePath, 'llama.cpp executable', { executable: true }), modelPath: await validateRuntimePath(modelPath, 'llama.cpp model'), options };
  };
  const endpointFor = options => `http://${options.host}:${options.port}/v1`;
  const waitForHealth = async (endpoint, signal, timeoutMs) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? signalError());
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('llama.cpp startup health check timed out'), { name: 'TimeoutError' })), timeoutMs);
    timer.unref?.();
    try {
      while (true) {
        if (controller.signal.aborted) throw signalError(controller.signal.reason);
        const result = await healthCheck({ endpoint }, controller.signal);
        if (result?.serverReady) return result;
        await new Promise((resolve, reject) => {
          const wait = setTimeout(resolve, 250);
          const onAbort = () => { clearTimeout(wait); reject(signalError(controller.signal.reason)); };
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const stop = async ({ force = false } = {}) => {
    await initialize();
    if (!child) return await save({ ...status, state: status.state === 'error' ? 'error' : 'idle', serverReady: false, pid: undefined, stoppedAt: now() });
    const process = child;
    await save({ ...status, state: 'stopping', serverReady: false });
    if (force) process.kill('SIGKILL'); else process.kill('SIGTERM');
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { process.kill('SIGKILL'); } catch {} finish(); }, status.stopTimeoutMs ?? LLAMA_CPP_RUNTIME_DEFAULTS.stopTimeoutMs);
      process.once?.('close', finish);
      process.once?.('exit', finish);
    });
    child = undefined;
    return await save({ ...status, state: 'idle', serverReady: false, pid: undefined, stoppedAt: now() });
  };
  const start = async ({ confirmed = false, signal } = {}) => {
    await initialize();
    if (confirmed !== true) throw new Error('Explicit confirmation is required before starting llama.cpp');
    if (child || status.state === 'starting' || status.state === 'running') return status;
    const { values, executablePath, modelPath, options } = await settingsForStart();
    const endpoint = endpointFor(options);
    await save({ ...status, mode: 'managed', configured: true, state: 'starting', serverReady: false, port: options.port, executableName: executablePath, modelName: modelPath, output: undefined, lastError: undefined, stopTimeoutMs: options.stopTimeoutMs });
    const args = ['-m', modelPath, '--host', options.host, '--port', String(options.port), '--ctx-size', String(options.contextSize), '--batch-size', String(options.batchSize), '--threads', String(options.threads)];
    let handle;
    try {
      if (signal?.aborted) throw signalError(signal.reason);
      handle = spawn(executablePath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '' },
      });
      child = handle;
      let output = '';
      const append = chunk => { output = redactRuntimeOutput(`${output}${chunk?.toString?.() || ''}`, [executablePath, modelPath]).slice(-MAX_OUTPUT_LENGTH); void save({ ...status, output }); };
      handle.stdout?.on?.('data', append); handle.stderr?.on?.('data', append);
      const exitPromise = new Promise((_, reject) => { handle.once?.('error', reject); handle.once?.('close', code => reject(new Error(`llama.cpp exited before health check (code ${code ?? 'unknown'})`))); });
      await Promise.race([waitForHealth(endpoint, signal, options.startupTimeoutMs), exitPromise]);
      const next = await save({ ...status, state: 'running', serverReady: true, pid: Number.isSafeInteger(handle.pid) ? handle.pid : undefined, startedAt: now(), output });
      // Persisting the managed endpoint lets generation use the exact endpoint that was started.
      const current = await loadSettings();
      await saveSettings({ ...current.values ?? current, 'providers.llama-cpp.endpoint': endpoint });
      return next;
    } catch (error) {
      try { handle?.kill?.('SIGTERM'); } catch {}
      child = undefined;
      await save({ ...status, state: 'error', serverReady: false, pid: undefined, lastError: safeMessage(error, 'llama.cpp failed to start') });
      throw error;
    }
  };
  const configure = async ({ executablePath, modelPath, confirmed = false } = {}) => {
    if (confirmed !== true) throw new Error('Explicit confirmation is required before saving llama.cpp paths');
    if (child || status.state === 'starting' || status.state === 'running' || status.state === 'stopping') throw new Error('Stop the managed llama.cpp runtime before changing its paths');
    const executable = await validateRuntimePath(executablePath, 'llama.cpp executable', { executable: true });
    const model = await validateRuntimePath(modelPath, 'llama.cpp model');
    const current = await loadSettings();
    await saveSettings({ ...(current.values ?? current), 'providers.llama-cpp.executablePath': executable, 'providers.llama-cpp.modelPath': model });
    return await save({ ...status, mode: 'managed', configured: true, executableName: executable, modelName: model, lastError: undefined });
  };
  const getStatus = async () => { await initialize(); return status; };
  return Object.freeze({ initialize, getStatus, configure, start, stop, endpointFor, validateRuntimePath });
};
