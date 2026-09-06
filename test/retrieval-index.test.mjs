import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RetrievalIndex } from '../server/retrieval-index.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-retrieval-index-test-'));
let settings = {
  'embeddings.enabled': false, 'embeddings.model': 'mini-v1', 'retrieval.mode': 'sparse',
  'retrieval.contextBudget': 4096, 'retrieval.rerank': false, 'retrieval.rerankerPlugin': 'builtin',
};
let embeddingFailure = true;
const issues = [];
const vectorFor = text => [text.toLowerCase().includes('terraform') ? 1 : 0, text.toLowerCase().includes('state') ? 1 : 0];
const index = new RetrievalIndex({
  sparsePath: join(directory, 'sparse.sqlite'),
  densePath: join(directory, 'dense.lance'),
  loadSettings: async () => ({ values: settings }),
  embed: async texts => {
    if (embeddingFailure) throw new Error('mock model is offline');
    return texts.map(vectorFor);
  },
  onDenseIssue: issue => issues.push(issue),
});
const record = {
  id: 'terraform-doc',
  data: { id: 'terraform-doc', name: 'Terraform', content: '# Terraform\n\nRemote state locking protects collaboration.', tags: ['iac'] },
};

test.after(async () => {
  await index.close();
  await rm(directory, { recursive: true, force: true });
});

test('keeps sparse retrieval available while dense work remains retryable', async () => {
  const sparseOnly = await index.indexDocument(record);
  assert.equal(sparseOnly.dense.status, 'disabled');
  assert.equal((await index.status()).dense.status, 'disabled');

  settings = { ...settings, 'embeddings.enabled': true, 'retrieval.mode': 'hybrid', 'retrieval.rerank': true };
  await assert.rejects(index.indexDocument(record), /Sparse indexing completed.*mock model is offline/);
  assert.equal(issues.length, 1);
  const unavailable = await index.status();
  assert.equal(unavailable.documentCount, 1);
  assert.equal(unavailable.dense.status, 'unavailable');

  const fallback = await index.retrieve({ query: 'Terraform state', documentIds: [record.id] });
  assert.equal(fallback.method, 'sparse-bm25');
  assert.equal(fallback.requestedMethod, 'hybrid-rrf');
  assert.equal(fallback.dense.status, 'unavailable');
  assert.equal(fallback.reranking.status, 'ready');
  assert.equal(fallback.results[0].documentId, record.id);
});

test('recovers the dense index when the configured model becomes available', async () => {
  embeddingFailure = false;
  const indexed = await index.indexDocument(record, { force: true });
  assert.equal(indexed.dense.status, 'ready');
  const status = await index.status();
  assert.equal(status.dense.status, 'ready');
  assert.equal(status.dense.chunkCount, 1);

  const hybrid = await index.retrieve({ query: 'Terraform state', documentIds: [record.id] });
  assert.equal(hybrid.method, 'hybrid-rrf');
  assert.equal(hybrid.reranking.diversity, 'maximal-marginal-relevance');
  assert.deepEqual(hybrid.results[0].retrievalChannels, ['sparse', 'dense']);

  settings = { ...settings, 'embeddings.model': 'mini-v2' };
  assert.equal((await index.status()).dense.status, 'not-built');
  const removed = await index.removeDocument(record.id);
  assert.equal(removed.sparse.removedChunks, 1);
  assert.equal(removed.dense.removedChunks, 1);
});

test('propagates retrieval cancellation instead of reporting a dense-model failure', async () => {
  let embeddingStarted;
  const started = new Promise(resolve => { embeddingStarted = resolve; });
  const cancellable = new RetrievalIndex({
    sparsePath: join(directory, 'cancel-sparse.sqlite'),
    densePath: join(directory, 'cancel-dense.lance'),
    loadSettings: async () => ({ values: {
      ...settings, 'embeddings.enabled': true, 'retrieval.mode': 'hybrid', 'retrieval.rerank': true,
    } }),
    embed: async (_texts, { signal }) => new Promise((_resolve, reject) => {
      embeddingStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  cancellable.indexSparseDocument(record);
  const controller = new AbortController();
  const pending = cancellable.retrieve({ query: 'Terraform state', documentIds: [record.id], signal: controller.signal });
  await started;
  controller.abort(Object.assign(new Error('Preview closed'), { name: 'AbortError' }));
  await assert.rejects(pending, error => error.name === 'AbortError' && /Preview closed/.test(error.message));
  assert.notEqual((await cancellable.status()).dense.status, 'unavailable');
  await cancellable.close();
});

test('keeps resolved plugin identities separate and uses the resolved embedder', async () => {
  const routedDirectory = join(directory, 'resolved-plugin');
  const invocations = [];
  const routed = new RetrievalIndex({
    sparsePath: join(routedDirectory, 'sparse.sqlite'),
    densePath: join(routedDirectory, 'dense.lance'),
    loadSettings: async () => ({ values: {
      ...settings, 'embeddings.enabled': true, 'retrieval.mode': 'hybrid', 'retrieval.rerank': false,
    } }),
    resolveEmbedding: async () => ({
      identity: 'plugin:dev.quizzer.embedder@2.0.0:mini-v1',
      embed: async (texts, options) => {
        invocations.push({ texts, options });
        return texts.map(vectorFor);
      },
    }),
  });
  try {
    const indexed = await routed.indexDocument(record);
    assert.equal(indexed.dense.embeddingModel, 'plugin:dev.quizzer.embedder@2.0.0:mini-v1');
    const retrieved = await routed.retrieve({ query: 'Terraform state', documentIds: [record.id] });
    assert.equal(retrieved.dense.embeddingModel, 'plugin:dev.quizzer.embedder@2.0.0:mini-v1');
    assert.equal(retrieved.results[0].documentId, record.id);
    assert.equal(invocations.length, 2);
  } finally {
    await routed.close();
  }
});

test('routes dense work through a vector-index plugin and drops stale plugin spans', async () => {
  const routedDirectory = join(directory, 'resolved-vector-index');
  const calls = [];
  let knownSpan;
  const vectorRoute = {
    component: 'dev.quizzer.vector',
    identity: 'plugin:dev.quizzer.vector@1.0.0',
    indexDocument: async source => {
      calls.push('index');
      knownSpan = `${source.id}:span:0:test`;
      return {
        id: source.id, name: source.data.name, versionHash: 'v1', chunks: 1, reused: false,
        embeddingModel: 'mini-v1', dimension: 2, tableName: 'plugin:test',
      };
    },
    retrieve: async () => {
      calls.push('retrieve');
      return [
        { sourceSpanId: knownSpan, documentId: record.id, tags: ['iac'], score: 0.95 },
        { sourceSpanId: 'deleted:span', documentId: 'deleted', tags: ['iac'], score: 0.99 },
      ];
    },
    status: async () => ({
      version: 1, engine: 'test-vector', tableCount: 1, chunkCount: 1,
      activeTableCount: 1, activeChunkCount: 1, tables: [],
    }),
    removeDocument: async id => { calls.push(`remove:${id}`); return { id, removedChunks: 1 }; },
  };
  const routed = new RetrievalIndex({
    sparsePath: join(routedDirectory, 'sparse.sqlite'),
    densePath: join(routedDirectory, 'dense.lance'),
    loadSettings: async () => ({ values: {
      ...settings,
      'embeddings.enabled': true,
      'retrieval.mode': 'hybrid',
      'retrieval.rerank': false,
      'retrieval.vectorIndexPlugin': vectorRoute.component,
    } }),
    embed: async texts => texts.map(vectorFor),
    resolveVectorIndex: async () => vectorRoute,
  });
  try {
    await routed.indexDocument(record);
    knownSpan = routed.sparse.retrieve({ query: 'Terraform state' }).results[0].sourceSpanId;
    const retrieved = await routed.retrieve({ query: 'Terraform state', tags: ['iac'] });
    assert.equal(retrieved.dense.component, vectorRoute.component);
    assert.ok(retrieved.results.some(result => result.sourceSpanId === knownSpan));
    assert.ok(!retrieved.results.some(result => result.sourceSpanId === 'deleted:span'));
    const status = await routed.status();
    assert.equal(status.dense.status, 'ready');
    assert.equal(status.dense.engine, 'test-vector');
    assert.equal(status.dense.databasePath, undefined);
    await routed.removeDocument(record.id);
    assert.ok(calls.includes('index'));
    assert.ok(calls.includes('retrieve'));
    assert.ok(calls.includes(`remove:${record.id}`));
  } finally {
    await routed.close();
  }
});

const planningSettings = mode => ({
  ...settings,
  'embeddings.enabled': false,
  'retrieval.mode': 'sparse',
  'retrieval.rerank': false,
  'retrieval.planning': mode,
});

const mockPreview = (query, results, confidence = 'high') => ({
  query,
  method: 'sparse-bm25',
  correctivePass: false,
  confidence,
  estimatedContextTokens: 0,
  results,
});

test('fuses bounded sparse variants before one final budget and neighbor expansion', async () => {
  const calls = [];
  let hydrated;
  const plannerIndex = new RetrievalIndex({
    sparsePath: join(directory, 'planner-sparse.sqlite'),
    densePath: join(directory, 'planner-dense.lance'),
    loadSettings: async () => ({ values: planningSettings('multi-query') }),
    embed: async texts => texts.map(vectorFor),
  });
  plannerIndex.sparse = {
    retrieve: options => {
      calls.push(options);
      return mockPreview(options.query, [
        { sourceSpanId: 'shared', content: 's'.repeat(800), score: 1, documentId: 'doc1' },
        { sourceSpanId: `only-${calls.length}`, content: 'u'.repeat(800), score: 0.5, documentId: 'doc1' },
      ]);
    },
    hydrateResults: (results, options) => {
      hydrated = { results, options };
      return results.map(result => ({ ...result, neighbors: [{ sourceSpanId: 'neighbor' }], parentContent: result.content }));
    },
    close: () => {},
  };
  try {
    const result = await plannerIndex.retrieve({
      query: 'What is Docker and Podman?', documentIds: ['doc1'], tags: ['containers'], limit: 5, contextBudget: 256,
    });
    assert.equal(calls.length, result.planningTrace.variants.length);
    assert.ok(calls.length > 1);
    assert.ok(calls.every(call => call.limit === 20 && call.contextBudget === 65_536 && call.includeNeighbors === false));
    assert.equal(calls[0].allowCorrectivePass, true);
    assert.ok(calls.slice(1).every(call => call.allowCorrectivePass === false));
    assert.ok(calls.every(call => call.documentIds[0] === 'doc1' && call.tags[0] === 'containers'));
    assert.deepEqual(result.results.map(item => item.sourceSpanId), ['shared']);
    assert.equal(result.estimatedContextTokens, 200);
    assert.equal(result.planningTrace.mode, 'multi-query');
    assert.equal(result.planningTrace.fallback, false);
    assert.equal(hydrated.options.includeNeighbors, true);
    assert.equal(result.results[0].neighbors.length, 1);
  } finally {
    await plannerIndex.close();
  }
});

test('preserves fused multi-query evidence when dense retrieval is unavailable', async () => {
  let calls = 0;
  const fallbackIndex = new RetrievalIndex({
    sparsePath: join(directory, 'planning-fallback-sparse.sqlite'),
    densePath: join(directory, 'planning-fallback-dense.lance'),
    loadSettings: async () => ({ values: {
      ...planningSettings('multi-query'),
      'embeddings.enabled': true,
      'retrieval.mode': 'hybrid',
    } }),
    embed: async () => { throw new Error('local embedding model unavailable'); },
  });
  fallbackIndex.sparse = {
    retrieve: options => {
      calls += 1;
      return mockPreview(options.query, [
        { sourceSpanId: 'shared', content: 'shared evidence', score: 1, documentId: 'doc1' },
        { sourceSpanId: `variant-${calls}`, content: 'variant evidence', score: 0.5, documentId: 'doc1' },
      ]);
    },
    hydrateResults: results => results,
    close: () => {},
  };
  try {
    const result = await fallbackIndex.retrieve({ query: 'Docker and Podman' });
    assert.equal(result.method, 'sparse-bm25');
    assert.equal(result.requestedMethod, 'hybrid-rrf');
    assert.equal(result.dense.status, 'unavailable');
    assert.equal(result.results[0].sourceSpanId, 'shared');
    assert.equal(result.results.filter(item => item.sourceSpanId === 'shared').length, 1);
    assert.ok(calls > 1);
  } finally {
    await fallbackIndex.close();
  }
});

test('uses only an explicitly injected local HyDE callback and traces honest fallbacks', async () => {
  const makeIndex = invokeLocalHyde => {
    const created = new RetrievalIndex({
      sparsePath: join(directory, `hyde-${Math.random()}.sqlite`),
      densePath: join(directory, `hyde-${Math.random()}.lance`),
      loadSettings: async () => ({ values: planningSettings('hyde') }),
      embed: async texts => texts.map(vectorFor),
      invokeLocalHyde,
    });
    created.sparse = {
      retrieve: options => mockPreview(options.query, [], 'low'),
      hydrateResults: results => results,
      close: () => {},
    };
    return created;
  };

  const noCallback = makeIndex();
  try {
    const result = await noCallback.retrieve({ query: 'Terraform state locking' });
    assert.equal(result.planningTrace.fallback, true);
    assert.equal(result.planningTrace.hyde, false);
    assert.match(result.planningTrace.reason, /No approved local HyDE callback/);
  } finally {
    await noCallback.close();
  }

  let callbackOptions;
  const localCallback = makeIndex(async (_query, options) => {
    callbackOptions = options;
    return 'A hypothetical local passage about Terraform state locking.';
  });
  try {
    const result = await localCallback.retrieve({ query: 'Terraform state locking' });
    assert.equal(callbackOptions.localOnly, true);
    assert.equal(result.planningTrace.hyde, true);
    assert.equal(result.planningTrace.fallback, false);
    assert.ok(result.planningTrace.variants.includes('A hypothetical local passage about Terraform state locking.'));
  } finally {
    await localCallback.close();
  }

  const failedCallback = makeIndex(async () => { throw new Error('private filesystem detail'); });
  try {
    const result = await failedCallback.retrieve({ query: 'Terraform state locking' });
    assert.equal(result.planningTrace.fallback, true);
    assert.match(result.planningTrace.reason, /local HyDE callback failed/);
    assert.doesNotMatch(result.planningTrace.reason, /filesystem/);
  } finally {
    await failedCallback.close();
  }
});

test('observes cancellation between deterministic query variants', async () => {
  const controller = new AbortController();
  let calls = 0;
  const cancelled = new RetrievalIndex({
    sparsePath: join(directory, 'planning-cancel-sparse.sqlite'),
    densePath: join(directory, 'planning-cancel-dense.lance'),
    loadSettings: async () => ({ values: planningSettings('multi-query') }),
    embed: async texts => texts.map(vectorFor),
  });
  cancelled.sparse = {
    retrieve: options => {
      calls += 1;
      controller.abort(Object.assign(new Error('Planning cancelled'), { name: 'AbortError' }));
      return mockPreview(options.query, []);
    },
    close: () => {},
  };
  try {
    await assert.rejects(
      cancelled.retrieve({ query: 'Docker and Podman', signal: controller.signal }),
      error => error.name === 'AbortError' && /Planning cancelled/.test(error.message),
    );
    assert.equal(calls, 1);
  } finally {
    await cancelled.close();
  }
});
