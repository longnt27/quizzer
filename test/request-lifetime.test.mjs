import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { bindRequestCancellation } from '../server/request-lifetime.mjs';

const exchange = () => {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.writableEnded = false;
  return { request, response };
};

test('aborts work when a request or unfinished response disconnects', () => {
  const first = exchange();
  const requestLifetime = bindRequestCancellation(first.request, first.response, 'Request left');
  first.request.emit('aborted');
  assert.equal(requestLifetime.signal.aborted, true);
  assert.equal(requestLifetime.signal.reason.name, 'AbortError');
  assert.match(requestLifetime.signal.reason.message, /Request left/);
  requestLifetime.dispose();

  const second = exchange();
  const responseLifetime = bindRequestCancellation(second.request, second.response);
  second.response.emit('close');
  assert.equal(responseLifetime.signal.aborted, true);
});

test('does not cancel completed responses and removes listeners on disposal', () => {
  const { request, response } = exchange();
  response.writableEnded = true;
  const lifetime = bindRequestCancellation(request, response);
  response.emit('close');
  assert.equal(lifetime.signal.aborted, false);
  lifetime.dispose();
  response.writableEnded = false;
  request.emit('aborted');
  response.emit('close');
  assert.equal(lifetime.signal.aborted, false);
  assert.throws(() => bindRequestCancellation({}, response), /HTTP request and response emitters/);
});
