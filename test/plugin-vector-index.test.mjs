import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVectorIndexProvider, validateVectorSearchResults } from '../server/plugin-vector-index.mjs';

const settings = (component = 'dev.quizzer.vector') => ({ values: {
  'retrieval.vectorIndexPlugin': component,
} });
const plugin = {
  id: 'dev.quizzer.vector', version: '1.2.3', status: 'installed', enabled: true, compatible: true,
  capabilities: ['vector-index'], permissions: { filesystem: ['scoped-temp', 'persistent-data'] },
};
const record = {
  id: 'doc-1',
  data: {
    name: 'Infrastructure',
    content: 'Terraform state tracks resources.',
    tags: ['iac'],
    parserVersion: 'test-1',
    chunks: [{ id: 'span-1', index: 0, start: 0, end: 33 }],
  },
};

test('delegates built-in vector operations without consulting plugins', async () => {
  const calls = [];
  const builtin = Object.fromEntries(['indexDocument', 'retrieve', 'removeDocument', 'status', 'close'].map(method => [
    method, async (...arguments_) => { calls.push([method, ...arguments_]); return { method }; },
  ]));
  builtin.databasePath = '/private/dense.lance';
  const route = await resolveVectorIndexProvider(settings('builtin'), { builtin });
  assert.equal(route.identity, 'builtin:lancedb');
  assert.equal(route.databasePath, builtin.databasePath);
  assert.deepEqual(await route.retrieve({ vector: [1] }), { method: 'retrieve' });
  assert.equal(calls[0][0], 'retrieve');
  await assert.rejects(resolveVectorIndexProvider(settings('builtin')), /Built-in vector index/);
});

test('indexes bounded vector metadata and implements the external lifecycle contract', async () => {
  const invocations = [];
  const manager = {
    list: async () => [plugin],
    invoke: async (id, method, params, options) => {
      invocations.push({ id, method, params, options });
      if (method === 'rag.index') return { result: { reused: false, chunks: 1 } };
      if (method === 'rag.search') return { result: { matches: [{
        sourceSpanId: 'doc-1:span-1', documentId: 'doc-1', tags: ['iac'], score: 0.9,
      }] } };
      if (method === 'rag.remove') return { result: { removedChunks: 1 } };
      return { result: { engine: 'test-vector', tableCount: 2, chunkCount: 10, activeTableCount: 1, activeChunkCount: 6 } };
    },
  };
  const route = await resolveVectorIndexProvider(settings(), { loadManager: async () => manager });
  assert.equal(route.identity, 'plugin:dev.quizzer.vector@1.2.3');
  const indexed = await route.indexDocument(record, {
    embeddingModel: 'plugin:embedder@1:model', embed: async texts => texts.map(() => [1, 0]), force: true,
  });
  assert.equal(indexed.chunks, 1);
  assert.equal(indexed.dimension, 2);
  const indexCall = invocations[0];
  assert.equal(indexCall.method, 'rag.index');
  assert.equal(indexCall.params.payloadPath, 'index/document.json');
  assert.equal(indexCall.params.force, true);
  assert.equal(indexCall.options.files[0].path, indexCall.params.payloadPath);
  const payload = JSON.parse(indexCall.options.files[0].data.toString());
  assert.equal(payload.rows[0].sourceSpanId, 'doc-1:span-1');
  assert.deepEqual(payload.rows[0].vector, [1, 0]);
  assert.equal(payload.rows[0].content, undefined);

  const signal = new AbortController().signal;
  assert.deepEqual(await route.retrieve({
    vector: [1, 0], embeddingModel: 'model', documentIds: ['doc-1', 'doc-1'], limit: 5, signal,
  }), [{ sourceSpanId: 'doc-1:span-1', documentId: 'doc-1', tags: ['iac'], score: 0.9 }]);
  assert.deepEqual(invocations[1].params.documentIds, ['doc-1']);
  assert.equal(invocations[1].options.signal, signal);
  assert.deepEqual(await route.removeDocument('doc-1'), { id: 'doc-1', removedChunks: 1 });
  assert.deepEqual(await route.status({ embeddingModel: 'model' }), {
    version: 1,
    engine: 'test-vector',
    component: plugin.id,
    identity: 'plugin:dev.quizzer.vector@1.2.3',
    tableCount: 2,
    chunkCount: 10,
    activeTableCount: 1,
    activeChunkCount: 6,
    tables: [],
  });
});

test('rejects unavailable plugins and unsafe vector-index envelopes', async () => {
  const resolve = overrides => resolveVectorIndexProvider(settings(), { loadManager: async () => ({
    list: async () => [{ ...plugin, ...overrides }], invoke: async () => ({ result: {} }),
  }) });
  for (const overrides of [
    { enabled: false }, { compatible: false }, { status: 'blocked' }, { capabilities: ['embedder'] },
    { permissions: { filesystem: ['scoped-temp'] } }, { permissions: { filesystem: ['persistent-data'] } },
  ]) await assert.rejects(resolve(overrides), error => error.code === 'provider_unavailable');
  await assert.rejects(resolveVectorIndexProvider(settings('../escape'), {}), /not configured correctly/);

  for (const matches of [
    {}, [null], [{ sourceSpanId: '', documentId: 'doc', tags: [], score: 1 }],
    [{ sourceSpanId: 'span', documentId: '', tags: [], score: 1 }],
    [{ sourceSpanId: 'span', documentId: 'doc', tags: [], score: -1 }],
    [{ sourceSpanId: 'span', documentId: 'doc', tags: 'iac', score: 1 }],
    [
      { sourceSpanId: 'span', documentId: 'doc', tags: [], score: 1 },
      { sourceSpanId: 'span', documentId: 'doc', tags: [], score: 0.5 },
    ],
  ]) assert.throws(() => validateVectorSearchResults(matches, 5), /Vector-index plugin/);
  assert.throws(() => validateVectorSearchResults(Array.from({ length: 2 }, (_, index) => ({
    sourceSpanId: `span-${index}`, documentId: 'doc', tags: [], score: 1,
  })), 1), /more than 1/);
});

test('preserves cancellation and converts process failure to provider unavailability', async () => {
  const failure = async error => resolveVectorIndexProvider(settings(), { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => { throw error; },
  }) });
  const failed = await failure(new Error('plugin crashed'));
  await assert.rejects(failed.retrieve({ vector: [1], embeddingModel: 'model' }), error => (
    error.code === 'provider_unavailable' && /plugin crashed/.test(error.message)
  ));
  const cancelled = await failure(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await assert.rejects(cancelled.retrieve({ vector: [1], embeddingModel: 'model' }), error => error.name === 'AbortError');
});

test('validates every stateful vector-index operation before accepting plugin data', async () => {
  const responses = {
    'rag.index': { reused: false, chunks: 1 },
    'rag.search': { matches: [] },
    'rag.remove': { removedChunks: 1 },
    'rag.status': { engine: 'test', tableCount: 1, chunkCount: 1, activeTableCount: 1, activeChunkCount: 1 },
  };
  const route = await resolveVectorIndexProvider(settings(), { loadManager: async () => ({
    list: async () => [plugin],
    invoke: async (_id, method) => ({ result: responses[method] }),
  }) });
  const indexOptions = { embeddingModel: 'model', embed: async texts => texts.map(() => [1, 0]) };

  for (const invalid of [undefined, {}, { id: 1 }, { id: 'doc', data: {} }]) {
    await assert.rejects(route.indexDocument(invalid, indexOptions), /stored document/);
  }
  await assert.rejects(route.indexDocument({ ...record, id: 'x'.repeat(501) }, indexOptions), /document id/);
  await assert.rejects(route.indexDocument({ ...record, data: { ...record.data, content: '   ' } }, indexOptions), /no indexable text/);
  await assert.rejects(route.indexDocument({
    ...record, data: { ...record.data, chunks: [{ id: 'blank', text: '   ' }] },
  }, indexOptions), /1 to 10000 chunks/);
  await assert.rejects(route.indexDocument({
    ...record, data: { ...record.data, tags: [''] },
  }, indexOptions), /source row 1 tags/);
  await assert.rejects(route.indexDocument(record, {
    ...indexOptions, embed: async texts => texts.map(() => Array.from({ length: 8_193 }, () => 0)),
  }), /cannot exceed 8192 dimensions/);
  responses['rag.index'] = { reused: false, chunks: 0 };
  await assert.rejects(route.indexDocument(record, indexOptions), /confirm exactly 1/);
  responses['rag.index'] = { reused: false, chunks: 1 };

  await assert.rejects(route.retrieve({ vector: Array.from({ length: 8_193 }, () => 0), embeddingModel: 'model' }), /cannot exceed/);
  await assert.rejects(route.retrieve({ vector: [1], embeddingModel: 'model', documentIds: {} }), /documentIds/);
  await assert.rejects(route.retrieve({ vector: [1], embeddingModel: 'model', documentIds: [''] }), /documentIds/);
  await assert.rejects(route.retrieve({ vector: [1], embeddingModel: 'model', limit: 0 }), /limit/);
  await assert.rejects(route.removeDocument(''), /document id/);
  responses['rag.remove'] = { removedChunks: -1 };
  await assert.rejects(route.removeDocument('doc-1'), /invalid removal/);

  responses['rag.status'] = null;
  await assert.rejects(route.status({ embeddingModel: 'model' }), /status is invalid/);
  responses['rag.status'] = { engine: 'test', tableCount: -1, chunkCount: 0, activeTableCount: 0, activeChunkCount: 0 };
  await assert.rejects(route.status({ embeddingModel: 'model' }), /tableCount is invalid/);
});
