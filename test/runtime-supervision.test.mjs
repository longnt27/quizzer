import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { stopChildren, superviseChildren, terminateChild } from '../scripts/runtime.mjs';

class FakeChild extends EventEmitter {
  constructor(pid = 1234) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killCalls = [];
  }

  kill(signal) {
    this.killCalls.push(signal);
    this.killed = true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

class FakeProcess extends EventEmitter {}

const fakeKiller = () => new EventEmitter();

const exitsWhenKilled = child => {
  const kill = child.kill.bind(child);
  child.kill = signal => {
    kill(signal);
    queueMicrotask(() => child.exit(0, signal));
  };
  return child;
};

test('terminates POSIX children gracefully with the requested signal', () => {
  const child = new FakeChild();
  const spawned = [];
  terminateChild(child, 'SIGTERM', {
    platform: 'linux',
    spawnProcess: (...args) => { spawned.push(args); return fakeKiller(); },
  });
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.deepEqual(spawned, []);
});

test('uses graceful Windows tree termination without force', () => {
  const child = new FakeChild(4321);
  const spawned = [];
  terminateChild(child, 'SIGTERM', {
    platform: 'win32',
    spawnProcess: (...args) => { spawned.push(args); return fakeKiller(); },
  });
  assert.deepEqual(spawned[0].slice(0, 2), ['taskkill', ['/pid', '4321', '/T']]);
  assert.deepEqual(child.killCalls, []);
});

test('uses forced Windows tree termination during escalation', async () => {
  const child = new FakeChild(4321);
  const spawned = [];
  await stopChildren([child], 'SIGTERM', {
    platform: 'win32',
    timeoutMs: 5,
    spawnProcess: (...args) => {
      spawned.push(args);
      const killer = fakeKiller();
      if (args[1].includes('/F')) child.exit(0, 'SIGKILL');
      queueMicrotask(() => killer.emit('exit', 0));
      return killer;
    },
  });
  assert.deepEqual(spawned.map(call => call.slice(0, 2)), [
    ['taskkill', ['/pid', '4321', '/T']],
    ['taskkill', ['/pid', '4321', '/T', '/F']],
  ]);
  assert.deepEqual(child.killCalls, []);
});

test('falls back when taskkill reports an error and does not wait for it', async () => {
  const child = new FakeChild(4321);
  const killer = fakeKiller();
  terminateChild(child, 'SIGTERM', { platform: 'win32', spawnProcess: () => killer });
  killer.emit('error', new Error('taskkill unavailable'));
  assert.deepEqual(child.killCalls, ['SIGTERM']);

  child.exit();
  await stopChildren([child], 'SIGTERM', { platform: 'win32', timeoutMs: 10, spawnProcess: () => killer });
});

test('tears down siblings after the first child error and cleans signal listeners', async () => {
  const processHandle = new FakeProcess();
  const first = new FakeChild(1);
  const sibling = exitsWhenKilled(new FakeChild(2));
  const resultPromise = superviseChildren([first, sibling], {
    processHandle,
    platform: 'linux',
    timeoutMs: 25,
  });
  first.emit('error', new Error('spawn failed'));
  queueMicrotask(() => first.exit(1));
  const result = await resultPromise;
  assert.equal(result.code, 1);
  assert.ok(sibling.killCalls.includes('SIGTERM'));
  assert.equal(processHandle.listenerCount('SIGINT'), 0);
  assert.equal(processHandle.listenerCount('SIGTERM'), 0);
});

test('uses conventional exit codes for injected termination signals', async () => {
  for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const processHandle = new FakeProcess();
    const child = exitsWhenKilled(new FakeChild());
    const resultPromise = superviseChildren([child], {
      processHandle,
      platform: 'linux',
      timeoutMs: 25,
    });
    processHandle.emit(signal);
    const result = await resultPromise;
    assert.equal(result.code, expectedCode);
    assert.equal(processHandle.listenerCount('SIGINT'), 0);
    assert.equal(processHandle.listenerCount('SIGTERM'), 0);
  }
});
