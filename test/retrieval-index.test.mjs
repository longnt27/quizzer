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
