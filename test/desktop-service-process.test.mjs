import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { executableSearchPath, isValidServicePort, serviceRestartDelay, waitForServiceReady } from '../desktop/service-process.mjs';

test('adds common user CLI install locations without replacing the inherited path', () => {
  const posix = executableSearchPath({ PATH: '/usr/bin:/bin' }, { platform: 'darwin', homeDirectory: '/Users/learner' }).split(':');
  assert.deepEqual(posix.slice(0, 2), ['/usr/bin', '/bin']);
  assert.ok(posix.includes('/Users/learner/.local/bin'));
  assert.ok(posix.includes('/Users/learner/.volta/bin'));
  assert.ok(posix.includes('/opt/homebrew/bin'));
  assert.equal(posix.filter(entry => entry === '/usr/local/bin').length, 1);

  const windows = executableSearchPath({
    Path: 'C:\\Windows\\System32',
    APPDATA: 'C:\\Users\\learner\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\learner\\AppData\\Local',
  }, { platform: 'win32', homeDirectory: 'C:\\Users\\learner' }).split(';');
  assert.ok(windows.some(entry => entry.endsWith('AppData\\Roaming/npm')));
  assert.ok(windows.some(entry => entry.endsWith('Microsoft/WinGet/Links')));

  const linux = executableSearchPath({
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/learner',
  }, { platform: 'linux' }).split(':');
  assert.ok(linux.includes('/home/learner/.cargo/bin'));
  assert.equal(linux.filter(entry => entry === '/usr/local/bin').length, 1);
  assert.equal(linux.includes('/opt/homebrew/bin'), false);

  const minimalWindows = executableSearchPath({
    PATH: 'C:\\Tools;C:\\TOOLS',
    USERPROFILE: 'C:\\Users\\learner',
  }, { platform: 'win32' }).split(';');
  assert.deepEqual(minimalWindows, ['C:\\Tools']);

  assert.equal(executableSearchPath({}, { platform: 'linux', homeDirectory: '' }), '/usr/local/bin');
});

test('accepts only usable loopback service ports', () => {
  assert.equal(isValidServicePort(1), true);
  assert.equal(isValidServicePort(65_535), true);
  assert.equal(isValidServicePort(0), false);
  assert.equal(isValidServicePort(65_536), false);
  assert.equal(isValidServicePort('8787'), false);
});

test('backs off repeated service restarts with a bounded delay', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(serviceRestartDelay), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.throws(() => serviceRestartDelay(-1), /non-negative integer/);
});

test('waits for the utility service ready handshake and removes startup listeners', async () => {
  const service = new EventEmitter();
  const ready = waitForServiceReady(service, { timeoutMs: 1_000 });
  service.emit('message', { type: 'unrelated' });
  service.emit('message', { type: 'quizzer-service-ready', port: 43_210 });
  assert.equal(await ready, 43_210);
  assert.equal(service.listenerCount('message'), 0);
  assert.equal(service.listenerCount('exit'), 0);
  assert.equal(service.listenerCount('error'), 0);
});

test('rejects invalid ports, startup failures, and readiness timeouts', async () => {
  const invalid = new EventEmitter();
  const invalidReady = waitForServiceReady(invalid, { timeoutMs: 1_000 });
  invalid.emit('message', { type: 'quizzer-service-ready', port: 0 });
  await assert.rejects(invalidReady, /invalid port/);

  const failed = new EventEmitter();
  const failedReady = waitForServiceReady(failed, { timeoutMs: 1_000 });
  failed.emit('message', { type: 'quizzer-service-error', message: 'address unavailable' });
  await assert.rejects(failedReady, /address unavailable/);

  const timedOut = new EventEmitter();
  await assert.rejects(waitForServiceReady(timedOut, { timeoutMs: 5 }), /within 1 seconds/);
});
