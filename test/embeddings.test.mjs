import assert from 'node:assert/strict';
import test from 'node:test';
import {
  embedTextsWithGemini,
  embedTextsWithOllama,
  embedTextsWithOpenAI,
  embedTextsWithOpenAICompatible,
} from '../server/embeddings.mjs';

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

test('calls OpenAI-compatible embeddings with an optional bearer key', async () => {
  let request;
  const embeddings = await embedTextsWithOpenAICompatible(['one', 'two'], {
    model: 'embed-v1', endpoint: 'http://127.0.0.1:8080/v1', apiKey: 'secret', timeoutMs: 100,
    fetchImplementation: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, json: async () => ({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }) };
    },
  });
  assert.deepEqual(embeddings, [[1, 0], [0, 1]]);
  assert.equal(request.url, 'http://127.0.0.1:8080/v1/embeddings');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'embed-v1', input: ['one', 'two'] });
});

test('OpenAI embeddings use the official embeddings endpoint', async () => {
  let request;
  await embedTextsWithOpenAI(['hello'], {
    model: 'text-embedding-3-small', apiKey: 'openai-key', timeoutMs: 100,
    fetchImplementation: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, json: async () => ({ data: [{ embedding: [0.5, 0.5] }] }) };
    },
  });
  assert.equal(request.url, 'https://api.openai.com/v1/embeddings');
  assert.equal(request.options.headers.Authorization, 'Bearer openai-key');
});

test('Gemini batches embeddings with query/document retrieval formatting', async () => {
  const requests = [];
  const fetchImplementation = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }) };
  };
  await embedTextsWithGemini(['one', 'two'], {
    model: 'gemini-embedding-2', apiKey: 'gemini-key', outputDimensionality: 768, purpose: 'query', timeoutMs: 100,
    fetchImplementation,
  });
  await embedTextsWithGemini(['one', 'two'], {
    model: 'gemini-embedding-2', apiKey: 'gemini-key', outputDimensionality: 768, purpose: 'document', timeoutMs: 100,
    fetchImplementation,
  });

  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'gemini-key');
  const queryBody = JSON.parse(requests[0].options.body);
  assert.equal(queryBody.requests[0].content.parts[0].text, 'task: search result | query: one');
  assert.equal(queryBody.requests[0].outputDimensionality, 768);
  const documentBody = JSON.parse(requests[1].options.body);
  assert.equal(documentBody.requests[0].content.parts[0].text, 'title: none | text: one');
});

test('rejects oversized embedding text before any provider request is sent', async () => {
  let called = false;
  const fetchImplementation = async () => {
    called = true;
    return { ok: true, json: async () => ({ data: [{ embedding: [1] }] }) };
  };
  await assert.rejects(embedTextsWithOpenAICompatible(['x'.repeat(100_001)], {
    model: 'embed-v1', endpoint: 'http://127.0.0.1:8080/v1', fetchImplementation,
  }), /bounded|too large|100000/i);
  assert.equal(called, false);
});

test('rejects embedding responses that declare an oversized body before parsing', async () => {
  let parsed = false;
  await assert.rejects(embedTextsWithOpenAICompatible(['one'], {
    model: 'embed-v1', endpoint: 'http://127.0.0.1:8080/v1',
    fetchImplementation: async () => ({
      ok: true,
      headers: new Headers({ 'content-length': String(64 * 1024 * 1024 + 1) }),
      json: async () => { parsed = true; return { data: [{ embedding: [1, 0] }] }; },
    }),
  }), /response.*too large|response.*limit|64.*MiB/i);
  assert.equal(parsed, false);
});

test('rejects remote HTTP OpenAI-compatible endpoints and missing cloud credentials', async () => {
  await assert.rejects(embedTextsWithOpenAICompatible(['text'], {
    model: 'embed-v1', endpoint: 'http://example.com/v1', fetchImplementation: async () => {},
  }), /HTTPS|loopback/);
  await assert.rejects(embedTextsWithOpenAI(['text'], { model: 'text-embedding-3-small', apiKey: '' }), /API key/);
  await assert.rejects(embedTextsWithGemini(['text'], { model: 'gemini-embedding-2', apiKey: '' }), /API key/);
});

test('rejects malformed provider vectors', async () => {
  await assert.rejects(embedTextsWithOpenAICompatible(['one', 'two'], {
    model: 'embed-v1', endpoint: 'http://127.0.0.1:8080/v1',
    fetchImplementation: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) }),
  }), /returned 1 vectors for 2 texts/);
  await assert.rejects(embedTextsWithGemini(['one'], {
    model: 'gemini-embedding-2', apiKey: 'key',
    fetchImplementation: async () => ({ ok: true, json: async () => ({ embeddings: [{ values: [Number.NaN] }] }) }),
  }), /invalid or inconsistent/);
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
