import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DenseDocumentIndex } from '../server/dense-index.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-dense-index-test-'));
const index = new DenseDocumentIndex(join(directory, 'dense.lance'));
test.after(async () => {
  await index.close();
  await rm(directory, { recursive: true, force: true });
});

const vectorFor = text => {
  const normalized = text.toLowerCase();
  return [
    normalized.includes('apple') ? 1 : 0,
    normalized.includes('terraform') ? 1 : 0,
    normalized.includes('network') ? 1 : 0,
  ];
};
let embeddingCalls = 0;
const embed = async texts => {
  embeddingCalls += 1;
  return texts.map(vectorFor);
};
const record = (id, name, content, tags = []) => ({
  id,
  data: { id, name, content, tags, contentHash: id.padEnd(64, '0').slice(0, 64), parserVersion: 'test-1' },
});

test('builds model-versioned LanceDB tables and reuses unchanged documents', async () => {
  const apple = record('apple-doc', 'Apples', 'Apple orchards produce fruit.', ['food']);
  const terraform = record('terraform-doc', 'Terraform', 'Terraform state tracks infrastructure.', ['iac']);
  const first = await index.indexDocument(apple, { embeddingModel: 'test-mini-1', embed });
  await index.indexDocument(terraform, { embeddingModel: 'test-mini-1', embed });
  assert.equal(first.reused, false);
  assert.equal(first.dimension, 3);
  const repeated = await index.indexDocument(apple, { embeddingModel: 'test-mini-1', embed });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.tableName, first.tableName);
  assert.equal(embeddingCalls, 2);

  const results = await index.retrieve({ vector: vectorFor('apple'), embeddingModel: 'test-mini-1', limit: 5 });
  assert.equal(results[0].documentId, 'apple-doc');
  assert.equal(results[0].tags[0], 'food');
  assert.match(results[0].sourceSpanId, /^apple-doc:/);
  const scoped = await index.retrieve({
    vector: vectorFor('apple'), embeddingModel: 'test-mini-1', documentIds: ['terraform-doc'], limit: 5,
  });
  assert.deepEqual(scoped.map(result => result.documentId), ['terraform-doc']);

  const otherModel = await index.indexDocument(apple, {
    embeddingModel: 'test-multilingual-2', embed: async texts => texts.map(text => [...vectorFor(text), 0]),
  });
  assert.notEqual(otherModel.tableName, first.tableName);
  const status = await index.status();
  assert.equal(status.engine, 'lancedb');
  assert.equal(status.tableCount, 2);
  assert.equal(status.chunkCount, 3);
});

test('removes a document from every model table and rejects malformed embeddings', async () => {
  const removed = await index.removeDocument('apple-doc');
  assert.equal(removed.removedChunks, 2);
  const remaining = await index.retrieve({ vector: vectorFor('apple'), embeddingModel: 'test-mini-1' });
  assert.deepEqual(remaining.map(result => result.documentId), ['terraform-doc']);
  await assert.rejects(index.indexDocument(record('bad-doc', 'Bad', 'Invalid vectors'), {
    embeddingModel: 'broken', embed: async () => [[1, Number.NaN]],
  }), /invalid or inconsistent/);
  await assert.rejects(index.retrieve({ vector: [], embeddingModel: 'test-mini-1' }), /invalid or inconsistent/);
});

test('validates dense-index inputs and safely handles missing or empty tables', async () => {
  assert.throws(() => new DenseDocumentIndex(''), /database path/);
  for (const invalidRecord of [undefined, {}, { id: 1 }, { id: 'bad', data: {} }]) {
    await assert.rejects(index.indexDocument(invalidRecord, { embeddingModel: 'test', embed }), /stored document/);
  }
  await assert.rejects(index.indexDocument(record('empty-doc', 'Empty', '   '), {
    embeddingModel: 'test', embed,
  }), /no indexable text/);
  const blankChunk = record('blank-chunk', 'Blank', 'source');
  blankChunk.data.chunks = [{ id: 'blank', text: '   ' }];
  await assert.rejects(index.indexDocument(blankChunk, {
    embeddingModel: 'test', embed, force: true,
  }), /no indexable chunks/);
  await assert.rejects(index.indexDocument(record('missing-model', 'Missing model', 'source'), {
    embeddingModel: ' ', embed,
  }), /embedding model/);
  await assert.rejects(index.indexDocument(record('missing-provider', 'Missing provider', 'source'), {
    embeddingModel: 'test',
  }), /embedding provider/);

  await assert.rejects(index.indexDocument(record('wrong-count', 'Wrong count', 'source'), {
    embeddingModel: 'broken-count', embed: async () => [],
  }), /returned 0 vectors for 1 chunks/);
  await assert.rejects(index.indexDocument(record('wrong-shape', 'Wrong shape', 'source'), {
    embeddingModel: 'broken-shape', embed: async () => [null],
  }), /invalid or inconsistent/);
  await assert.rejects(index.indexDocument(record('wrong-length', 'Wrong length', 'source'), {
    embeddingModel: 'broken-length', embed: async () => [[1, 2], [1]],
  }), /returned 2 vectors for 1 chunks/);

  assert.deepEqual(await index.retrieve({ vector: [1, 0], embeddingModel: 'not-indexed' }), []);
  await assert.rejects(index.retrieve({ vector: [1], embeddingModel: '' }), /embedding model/);
  for (const limit of [0, 101, 1.5]) {
    await assert.rejects(index.retrieve({ vector: [1], embeddingModel: 'test', limit }), /limit/);
  }
  await assert.rejects(index.removeDocument(''), /document id/);

  await index.removeDocument('terraform-doc');
  const emptyStatus = await index.status();
  assert.equal(emptyStatus.chunkCount, 0);
  assert.ok(emptyStatus.tables.every(table => table.embeddingModel === undefined && table.dimension === undefined));
});
