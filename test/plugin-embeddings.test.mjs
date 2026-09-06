import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmbeddingProvider, validatePluginEmbeddings } from '../server/plugin-embeddings.mjs';

const settings = (component = 'dev.quizzer.embedder') => ({ values: {
  'embeddings.embedderPlugin': component,
  'embeddings.model': 'mini-multilingual',
} });
const plugin = {
  id: 'dev.quizzer.embedder', version: '1.2.3', status: 'installed', enabled: true, compatible: true,
  capabilities: ['embedder'],
};

test('resolves built-in embeddings without consulting the plugin manager', async () => {
  let invocation;
  const signal = new AbortController().signal;
  const route = await resolveEmbeddingProvider(settings('builtin'), {
    builtin: async (...args) => { invocation = args; return [[1, 0]]; },
  });
  assert.equal(route.component, 'builtin');
  assert.equal(route.identity, 'mini-multilingual');
  assert.deepEqual(await route.embed(['Terraform'], { signal }), [[1, 0]]);
  assert.deepEqual(invocation, [['Terraform'], { model: 'mini-multilingual', signal }]);
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
  const route = await resolveEmbeddingProvider(settings(), { loadManager: async () => manager });
  assert.equal(route.identity, 'plugin:dev.quizzer.embedder@1.2.3:mini-multilingual');
  assert.deepEqual(await route.embed(['one', 'two'], { signal }), [[1, 0], [0, 1]]);
  assert.deepEqual(invocation, [
    plugin.id, 'rag.embed', { texts: ['one', 'two'], model: 'mini-multilingual' },
    { signal, timeoutMs: 300_000 },
  ]);
});

test('isolates unavailable, malformed, failed, and cancelled embedder plugins', async () => {
  const request = overrides => resolveEmbeddingProvider(settings(), { loadManager: async () => ({
    list: async () => [{ ...plugin, ...overrides }],
    invoke: async () => ({ result: { embeddings: [[1, 0]] } }),
  }) });
  for (const overrides of [{ enabled: false }, { compatible: false }, { status: 'blocked' }, { capabilities: ['reranker'] }]) {
    const route = await request(overrides);
    await assert.rejects(route.embed(['one']), error => error.code === 'provider_unavailable' && /not installed/.test(error.message));
  }
  await assert.rejects(resolveEmbeddingProvider(settings('../escape'), {}), /not configured correctly/);

  for (const embeddings of [undefined, [], [null], [[1], [2]], [[1, Number.NaN]], [Array.from({ length: 8_193 }, () => 0)]]) {
    const route = await resolveEmbeddingProvider(settings(), { loadManager: async () => ({
      list: async () => [plugin], invoke: async () => ({ result: { embeddings } }),
    }) });
    await assert.rejects(route.embed(['one']), /wrong number|invalid or inconsistent/);
  }

  const failed = await resolveEmbeddingProvider(settings(), { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => { throw new Error('process crashed'); },
  }) });
  await assert.rejects(failed.embed(['one']), error => error.code === 'provider_unavailable' && /process crashed/.test(error.message));
  const cancelled = await resolveEmbeddingProvider(settings(), { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  }) });
  await assert.rejects(cancelled.embed(['one']), error => error.name === 'AbortError');
});

test('bounds plugin text inputs and validates vectors directly', async () => {
  const route = await resolveEmbeddingProvider(settings(), { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => ({ result: { embeddings: [[1]] } }),
  }) });
  await assert.rejects(route.embed([]), /1-250 bounded strings/);
  await assert.rejects(route.embed(Array.from({ length: 251 }, () => 'x')), /1-250 bounded strings/);
  await assert.rejects(route.embed(['x'.repeat(100_001)]), /1-250 bounded strings/);
  await assert.rejects(route.embed(Array.from({ length: 21 }, () => 'x'.repeat(100_000))), /1-250 bounded strings/);
  assert.deepEqual(validatePluginEmbeddings([[0, 1]], 1), [[0, 1]]);
});
