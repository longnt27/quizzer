import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLlamaCppRuntime, redactRuntimeOutput, validateRuntimeOptions, validateRuntimePath } from '../server/llama-cpp-runtime.mjs';

const files = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-llama-runtime-test-'));
  const executable = join(directory, 'llama-server');
  const model = join(directory, 'model.gguf');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o700);
  await writeFile(model, 'fake model');
  return { directory, executable, model };
};

const fakeProcess = () => {
  const process = new EventEmitter();
  process.pid = 4242;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.killed = [];
  process.kill = signal => { process.killed.push(signal); queueMicrotask(() => process.emit('close', 0)); return true; };
  return process;
};

test('validates bounded managed runtime options and paths', async () => {
  const { executable, model } = await files();
  assert.deepEqual(validateRuntimeOptions({ port: 9000, contextSize: 8192, batchSize: 128, threads: 6 }).port, 9000);
  assert.throws(() => validateRuntimeOptions({ port: 80 }), /port must be an integer from/);
  await assert.rejects(() => validateRuntimePath('relative', 'executable'), /absolute path/);
  await assert.rejects(() => validateRuntimePath(`${executable}\nsecret`, 'executable'), /absolute path/);
  assert.equal(await validateRuntimePath(executable, 'executable', { executable: true }), executable);
  assert.equal(await validateRuntimePath(model, 'model'), model);
  assert.match(redactRuntimeOutput(`failed at ${executable}: \u001b[31msecret\u001b[0m`, [executable]), /\[llama-server\]/);
});

test('requires confirmation, starts with fixed arguments, health-checks, persists sanitized status, and stops', async () => {
  const { directory, executable, model } = await files();
  let rawSettings = {
    'hardware.profile': 'balanced',
    'generation.concurrency': 7,
    'providers.llama-cpp.executablePath': executable,
    'providers.llama-cpp.modelPath': model,
    'providers.llama-cpp.managedPort': 9123,
    'providers.llama-cpp.contextSize': 8192,
    'providers.llama-cpp.batchSize': 128,
    'providers.llama-cpp.threads': 8,
  };
  const calls = [];
  const child = fakeProcess();
  const runtime = createLlamaCppRuntime({
    appDataDirectory: directory,
    statusPath: join(directory, 'status.json'),
    loadSettings: async () => ({ values: { ...rawSettings } }),
    patchSettings: async values => { rawSettings = { ...rawSettings, ...values }; },
    detectHardware: () => ({ cpuCores: 4, memoryGB: 8 }),
    spawn: (command, args, options) => { calls.push({ command, args, options }); return child; },
    healthCheck: async ({ endpoint }) => ({ serverReady: endpoint === 'http://127.0.0.1:9123/v1' }),
  });
  await assert.rejects(() => runtime.start(), /Explicit confirmation/);
  await runtime.configure({ executablePath: executable, modelPath: model, confirmed: true });
  const started = await runtime.start({ confirmed: true });
  assert.equal(started.state, 'running');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-m', model, '--host', '127.0.0.1', '--port', '9123', '--ctx-size', '8192', '--batch-size', '128', '--threads', '4']);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, { PATH: process.env.PATH || '' });
  assert.equal(rawSettings['providers.llama-cpp.endpoint'], 'http://127.0.0.1:9123/v1');
  assert.equal(rawSettings['hardware.profile'], 'balanced');
  assert.equal(rawSettings['generation.concurrency'], 7);
  assert.equal(rawSettings['providers.llama-cpp.contextSize'], 8192);
  assert.equal((await runtime.getStatus()).executableName, 'llama-server');
  assert.equal((await runtime.stop()).state, 'idle');
  assert.deepEqual(child.killed, ['SIGTERM']);
});

test('startup failure is bounded and status never exposes full paths', async () => {
  const { directory, executable, model } = await files();
  const child = fakeProcess();
  const runtime = createLlamaCppRuntime({
    appDataDirectory: directory,
    statusPath: join(directory, 'status.json'),
    loadSettings: async () => ({ values: {
      'providers.llama-cpp.executablePath': executable, 'providers.llama-cpp.modelPath': model,
      'providers.llama-cpp.managedPort': 9124, 'providers.llama-cpp.contextSize': 4096,
      'providers.llama-cpp.batchSize': 512, 'providers.llama-cpp.threads': 2,
    } }),
    saveSettings: async () => {}, spawn: () => child,
    healthCheck: async () => ({ serverReady: false }),
  });
  await assert.rejects(() => runtime.start({ confirmed: true, signal: AbortSignal.timeout(1_000) }), /health check timed out|cancelled|exited|aborted/);
  const status = await runtime.getStatus();
  assert.equal(status.state, 'error');
  assert.doesNotMatch(JSON.stringify(status), new RegExp(executable.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(status), new RegExp(model.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('marks a healthy runtime failed when its process exits unexpectedly', async () => {
  const { directory, executable, model } = await files();
  const child = fakeProcess();
  const runtime = createLlamaCppRuntime({
    appDataDirectory: directory,
    statusPath: join(directory, 'status.json'),
    loadSettings: async () => ({ values: {
      'providers.llama-cpp.executablePath': executable, 'providers.llama-cpp.modelPath': model,
      'providers.llama-cpp.managedPort': 9125, 'providers.llama-cpp.contextSize': 4096,
      'providers.llama-cpp.batchSize': 512, 'providers.llama-cpp.threads': 2,
    } }),
    patchSettings: async () => {}, spawn: () => child,
    healthCheck: async () => ({ serverReady: true }),
  });
  await runtime.start({ confirmed: true });
  child.emit('close', 9);
  await new Promise(resolve => setImmediate(resolve));
  const status = await runtime.getStatus();
  assert.equal(status.state, 'error');
  assert.equal(status.serverReady, false);
  assert.match(status.lastError, /exited/);
});

test('forced stop uses the force signal and clears durable status', async () => {
  const { directory, executable, model } = await files();
  const child = fakeProcess();
  const runtime = createLlamaCppRuntime({
    appDataDirectory: directory,
    statusPath: join(directory, 'status.json'),
    loadSettings: async () => ({ values: {
      'providers.llama-cpp.executablePath': executable, 'providers.llama-cpp.modelPath': model,
      'providers.llama-cpp.managedPort': 9126, 'providers.llama-cpp.contextSize': 4096,
      'providers.llama-cpp.batchSize': 512, 'providers.llama-cpp.threads': 2,
    } }),
    patchSettings: async () => {}, spawn: () => child,
    healthCheck: async () => ({ serverReady: true }),
  });
  await runtime.start({ confirmed: true });
  assert.equal((await runtime.stop({ force: true })).state, 'idle');
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('serializes output status writes and recovers after a transient persistence failure', async () => {
  const { directory, executable, model } = await files();
  const statusPath = join(directory, 'status.json');
  const child = fakeProcess();
  const runtime = createLlamaCppRuntime({
    appDataDirectory: directory, statusPath,
    loadSettings: async () => ({ values: {
      'providers.llama-cpp.executablePath': executable, 'providers.llama-cpp.modelPath': model,
      'providers.llama-cpp.managedPort': 9127, 'providers.llama-cpp.contextSize': 4096,
      'providers.llama-cpp.batchSize': 512, 'providers.llama-cpp.threads': 2,
    } }),
    patchSettings: async () => {}, spawn: () => child,
    healthCheck: async () => ({ serverReady: true }),
  });
  await runtime.start({ confirmed: true });
  await rm(statusPath);
  await mkdir(statusPath);
  child.stdout.emit('data', `${model} emitted a bounded line`);
  await new Promise(resolve => setTimeout(resolve, 150));
  await rm(statusPath, { recursive: true, force: true });
  assert.equal((await runtime.stop()).state, 'idle');
});
