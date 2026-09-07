import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LLAMA_CPP_ENDPOINT,
  DEFAULT_LLAMA_CPP_MODEL,
  getLlamaCppStatus,
  llamaCppCompletionsUrl,
  runLlamaCppGeneration,
  validateLlamaCppEndpoint,
  validateLlamaCppModel,
} from '../server/llama-cpp-generation.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

test('keeps llama.cpp local-only and resolves its OpenAI-compatible endpoint', () => {
  assert.equal(validateLlamaCppEndpoint(DEFAULT_LLAMA_CPP_ENDPOINT), DEFAULT_LLAMA_CPP_ENDPOINT);
  assert.equal(validateLlamaCppModel(DEFAULT_LLAMA_CPP_MODEL), DEFAULT_LLAMA_CPP_MODEL);
  assert.equal(llamaCppCompletionsUrl('http://localhost:8080/v1'), 'http://localhost:8080/v1/chat/completions');
  assert.throws(() => validateLlamaCppEndpoint('https://models.example.test/v1'), /loopback/);
  assert.throws(() => validateLlamaCppEndpoint('http://192.168.1.5:8080/v1'), /loopback/);
});

test('reuses bounded cancellable JSON generation for llama.cpp without an API key', async () => {
  let request;
  const output = await runLlamaCppGeneration({
    endpoint: 'http://127.0.0.1:8080/v1', model: 'llama-3.2-q4', prompt: 'Answer this', schema,
  }, undefined, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }), { status: 200 });
  });
  assert.equal(output, '{"answer":"ok"}');
  assert.equal(request.url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(request.options.body).model, 'llama-3.2-q4');
});

test('reports llama.cpp health and optional model capabilities with bounded requests', async () => {
  const calls = [];
  const status = await getLlamaCppStatus({ endpoint: 'http://127.0.0.1:8080/v1' }, async (url, options) => {
    calls.push(url);
    if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    return new Response(JSON.stringify({ data: [{ id: 'llama-3.2-q4' }, { id: '' }] }), { status: 200 });
  });
  assert.equal(status.configured, true);
  assert.equal(status.serverReady, true);
  assert.deepEqual(status.models, [{ id: 'llama-3.2-q4' }]);
  assert.deepEqual(status.capabilities, ['generator', 'json-schema', 'cancellation']);
  assert.deepEqual(calls, ['http://127.0.0.1:8080/health', 'http://127.0.0.1:8080/v1/models']);
});

test('returns an unavailable status when the local server cannot be reached', async () => {
  const status = await getLlamaCppStatus({ endpoint: DEFAULT_LLAMA_CPP_ENDPOINT }, async () => { throw new Error('offline'); });
  assert.deepEqual(status, { configured: true, serverReady: false, models: [], capabilities: [], error: 'llama.cpp server is unavailable' });
});
