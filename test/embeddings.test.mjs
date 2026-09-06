import assert from 'node:assert/strict';
import test from 'node:test';
import { embedTextsWithOllama } from '../server/embeddings.mjs';

test('calls the configured Ollama embedding model with bounded input', async () => {
  let request;
  const embeddings = await embedTextsWithOllama(['one', 'two'], {
    model: 'mini-test', host: 'http://127.0.0.1:9999/base', timeoutMs: 100,
    fetchImplementation: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, json: async () => ({ embeddings: [[1, 0], [0, 1]] }) };
    },
  });
  assert.deepEqual(embeddings, [[1, 0], [0, 1]]);
  assert.equal(request.url, 'http://127.0.0.1:9999/api/embed');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'mini-test', input: ['one', 'two'] });
  assert.equal(request.options.signal.aborted, false);
});

test('rejects invalid embedding requests and unavailable model responses', async () => {
  await assert.rejects(embedTextsWithOllama([], { fetchImplementation: async () => {} }), /1-250 strings/);
  await assert.rejects(embedTextsWithOllama(['text'], { model: ' ' }), /model is required/);
  await assert.rejects(embedTextsWithOllama(['text'], { timeoutMs: 0 }), /timeout/);
  await assert.rejects(embedTextsWithOllama(['text'], { host: 'file:///tmp/ollama' }), /HTTP or HTTPS/);
  await assert.rejects(embedTextsWithOllama(['text'], { fetchImplementation: null }), /fetch implementation/);
  await assert.rejects(embedTextsWithOllama(['text'], {
    model: 'missing', fetchImplementation: async () => ({ ok: false, json: async () => ({ error: 'missing' }) }),
  }), /missing is unavailable/);
  await assert.rejects(embedTextsWithOllama(['text'], {
    fetchImplementation: async () => ({ ok: true, json: async () => { throw new Error('invalid json'); } }),
  }), /unavailable/);
});

test('forwards cancellation to the Ollama request', async () => {
  const controller = new AbortController();
  const pending = embedTextsWithOllama(['text'], {
    signal: controller.signal,
    fetchImplementation: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(pending, /cancelled by test/);
});
