import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmbeddingProvider, validatePluginEmbeddings } from '../server/plugin-embeddings.mjs';

const settings = ({ provider, component = 'builtin', model = 'mini-multilingual', endpoint, allowRemote = false } = {}) => ({ values: {
  ...(provider ? { 'embeddings.provider': provider } : {}),
  'embeddings.embedderPlugin': component,
  'embeddings.model': model,
  ...(endpoint ? { 'embeddings.openaiCompatible.endpoint': endpoint } : {}),
  'embeddings.allowRemote': allowRemote,
} });
const plugin = {
  id: 'dev.quizzer.embedder', version: '1.2.3', status: 'installed', enabled: true, compatible: true,
  capabilities: ['embedder'],
};

test('keeps legacy builtin settings on Ollama with provider-qualified identity', async () => {
  let invocation;
  const signal = new AbortController().signal;
  const route = await resolveEmbeddingProvider(settings(), {
    ollama: async (...args) => { invocation = args; return [[1, 0]]; },
  });
  assert.equal(route.component, 'ollama');
  assert.equal(route.identity, 'ollama:mini-multilingual');
  assert.equal(route.privacy, 'local');
  assert.deepEqual(await route.embed(['Terraform'], { purpose: 'query', signal }), [[1, 0]]);
  assert.deepEqual(invocation, [['Terraform'], { model: 'mini-multilingual', signal }]);
});

test('keeps legacy non-builtin settings on the plugin route', async () => {
  const manager = { list: async () => [plugin], invoke: async () => ({ result: { embeddings: [[1, 0]] } }) };
  const route = await resolveEmbeddingProvider(settings({ component: plugin.id }), { loadManager: async () => manager });
  assert.equal(route.component, 'plugin');
  assert.equal(route.identity, 'plugin:dev.quizzer.embedder@1.2.3:mini-multilingual');
});

test('routes OpenAI and Gemini through existing provider credentials', async () => {
  const invocations = [];
  const getCredential = provider => ({ openai: 'openai-key', gemini: 'gemini-key' })[provider];
  const openai = async (texts, options) => { invocations.push(['openai', texts, options]); return [[1, 0]]; };
  const gemini = async (texts, options) => { invocations.push(['gemini', texts, options]); return [[0, 1]]; };

  const openaiRoute = await resolveEmbeddingProvider(settings({ provider: 'openai', model: 'text-embedding-3-small', allowRemote: true }), { getCredential, openai });
  const geminiRoute = await resolveEmbeddingProvider(settings({ provider: 'gemini', model: 'gemini-embedding-2', allowRemote: true }), { getCredential, gemini });
  const signal = new AbortController().signal;
  await openaiRoute.embed(['one'], { purpose: 'query', signal });
  await geminiRoute.embed(['two'], { purpose: 'document', signal });

  assert.equal(openaiRoute.identity, 'openai:text-embedding-3-small');
  assert.equal(openaiRoute.privacy, 'remote-api');
  assert.equal(geminiRoute.identity, 'gemini:gemini-embedding-2:768:retrieval-v1');
  assert.deepEqual(invocations[0], ['openai', ['one'], { model: 'text-embedding-3-small', apiKey: 'openai-key', signal }]);
  assert.deepEqual(invocations[1], ['gemini', ['two'], { model: 'gemini-embedding-2', apiKey: 'gemini-key', outputDimensionality: 768, purpose: 'document', signal }]);
});

test('routes OpenAI-compatible endpoints with local/remote privacy and stable endpoint identity', async () => {
  const invocations = [];
  const compatible = async (texts, options) => { invocations.push(options); return [[1]]; };
  const local = await resolveEmbeddingProvider(settings({ provider: 'openai-compatible', model: 'embed-v1', endpoint: 'http://127.0.0.1:8080/v1' }), { openAICompatible: compatible });
  const remote = await resolveEmbeddingProvider(settings({ provider: 'openai-compatible', model: 'embed-v1', endpoint: 'https://embed.example.com/v1', allowRemote: true }), {
    openAICompatible: compatible,
    getCredential: provider => provider === 'openai-compatible' ? 'remote-key' : undefined,
  });
  assert.equal(local.privacy, 'local');
  assert.equal(remote.privacy, 'remote-api');
  assert.match(local.identity, /^openai-compatible:[a-f0-9]{12}:embed-v1$/);
  assert.notEqual(local.identity, remote.identity);
  await local.embed(['one'], { purpose: 'query' });
  await remote.embed(['two'], { purpose: 'document' });
  assert.equal(invocations[0].apiKey, undefined);
  assert.equal(invocations[1].apiKey, 'remote-key');
});

test('blocks remote embedding providers until the user explicitly allows remote embeddings', async () => {
  const route = await resolveEmbeddingProvider(settings({ provider: 'gemini', model: 'gemini-embedding-2' }), {
    getCredential: () => 'gemini-key',
    gemini: async () => [[1]],
  });
  await assert.rejects(route.embed(['private notes']), error => error.code === 'provider_unavailable' && /Remote embeddings are disabled/.test(error.message));
});

test('rejects missing cloud credentials before embedding content', async () => {
  let called = false;
  const openai = async () => { called = true; return [[1]]; };
  const route = await resolveEmbeddingProvider(settings({ provider: 'openai', model: 'text-embedding-3-small', allowRemote: true }), { openai, getCredential: () => undefined });
  await assert.rejects(route.embed(['secret document']), error => error.code === 'provider_unavailable' && /credential/.test(error.message));
  assert.equal(called, false);
});

test('uses installed plugin identity and validates its embedding envelope', async () => {
  let invocation;
  const manager = {
    list: async () => [plugin],
    invoke: async (...args) => {
      invocation = args;
      return { result: { embeddings: [[1, 0], [0, 1]] } };
    },
  };
  const signal = new AbortController().signal;
  const route = await resolveEmbeddingProvider(settings({ provider: 'plugin', component: plugin.id }), { loadManager: async () => manager });
  assert.deepEqual(await route.embed(['one', 'two'], { purpose: 'query', signal }), [[1, 0], [0, 1]]);
  assert.deepEqual(invocation, [
    plugin.id, 'rag.embed', { texts: ['one', 'two'], model: 'mini-multilingual' },
    { signal, timeoutMs: 300_000 },
  ]);
});

test('isolates unavailable, malformed, failed, and cancelled embedder plugins', async () => {
  const request = overrides => resolveEmbeddingProvider(settings({ provider: 'plugin', component: plugin.id }), { loadManager: async () => ({
    list: async () => [{ ...plugin, ...overrides }],
    invoke: async () => ({ result: { embeddings: [[1, 0]] } }),
  }) });
  for (const overrides of [{ enabled: false }, { compatible: false }, { status: 'blocked' }, { capabilities: ['reranker'] }]) {
    const route = await request(overrides);
    await assert.rejects(route.embed(['one']), error => error.code === 'provider_unavailable' && /not installed/.test(error.message));
  }
  await assert.rejects(resolveEmbeddingProvider(settings({ provider: 'plugin', component: '../escape' }), {}), /not configured correctly/);

  for (const embeddings of [undefined, [], [null], [[1], [2]], [[1, Number.NaN]], [Array.from({ length: 8_193 }, () => 0)]]) {
    const route = await resolveEmbeddingProvider(settings({ provider: 'plugin', component: plugin.id }), { loadManager: async () => ({
      list: async () => [plugin], invoke: async () => ({ result: { embeddings } }),
    }) });
    await assert.rejects(route.embed(['one']), /wrong number|invalid or inconsistent/);
  }

  const failed = await resolveEmbeddingProvider(settings({ provider: 'plugin', component: plugin.id }), { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => { throw new Error('process crashed'); },
  }) });
  await assert.rejects(failed.embed(['one']), error => error.code === 'provider_unavailable' && /process crashed/.test(error.message));
  const cancelled = await resolveEmbeddingProvider(settings({ provider: 'plugin', component: plugin.id }), { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  }) });
  await assert.rejects(cancelled.embed(['one']), error => error.name === 'AbortError');
});

test('bounds plugin text inputs and validates vectors directly', async () => {
  const route = await resolveEmbeddingProvider(settings({ provider: 'plugin', component: plugin.id }), { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => ({ result: { embeddings: [[1]] } }),
  }) });
  await assert.rejects(route.embed([]), /1-250 bounded strings/);
  await assert.rejects(route.embed(Array.from({ length: 251 }, () => 'x')), /1-250 bounded strings/);
  await assert.rejects(route.embed(['x'.repeat(100_001)]), /1-250 bounded strings/);
  await assert.rejects(route.embed(Array.from({ length: 21 }, () => 'x'.repeat(100_000))), /1-250 bounded strings/);
  assert.deepEqual(validatePluginEmbeddings([[0, 1]], 1), [[0, 1]]);
});
