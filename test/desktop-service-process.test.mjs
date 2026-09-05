import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { isValidServicePort, waitForServiceReady } from '../desktop/service-process.mjs';

test('accepts only usable loopback service ports', () => {
  assert.equal(isValidServicePort(1), true);
  assert.equal(isValidServicePort(65_535), true);
  assert.equal(isValidServicePort(0), false);
  assert.equal(isValidServicePort(65_536), false);
  assert.equal(isValidServicePort('8787'), false);
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
