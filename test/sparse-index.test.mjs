import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chunkDocument } from '../server/document-import.mjs';
import { SparseDocumentIndex } from '../server/sparse-index.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-sparse-index-test-'));
const index = new SparseDocumentIndex(join(directory, 'rag.sqlite'));

test.after(() => {
  index.close();
  return rm(directory, { recursive: true, force: true });
});

const record = (id, name, content, tags = []) => ({
  id,
  data: {
    id,
    name,
    content,
    tags,
    parserVersion: 'test-1',
    chunks: chunkDocument(id, content, 90),
  },
});

test('durably indexes stable source spans and reuses unchanged versions', () => {
  const terraform = record('doc-terraform', 'Terraform guide', `# State

Terraform state maps configuration resources to remote infrastructure.

## Collaboration

Remote state and locking prevent teammates from writing state concurrently.`, ['iac']);
  const indexed = index.indexDocument(terraform);
  assert.equal(indexed.reused, false);
  assert.ok(indexed.chunks >= 2);
  assert.equal(index.indexDocument(terraform).reused, true);
  assert.equal(index.status().documentCount, 1);
});

test('retrieves BM25 evidence with citations, parents, neighbors, and scoped filters', () => {
  index.indexDocument(record('doc-vietnamese', 'Hạ tầng', '# Hạ tầng\n\nKhóa trạng thái giúp cộng tác an toàn trong nhóm.', ['vietnamese']));
  const retrieval = index.retrieve({ query: 'remote state locking teammates', documentIds: ['doc-terraform'], limit: 3 });
  assert.equal(retrieval.confidence, 'high');
  assert.equal(retrieval.results[0].documentId, 'doc-terraform');
  assert.match(retrieval.results[0].sourceSpanId, /^doc-terraform:span:/);
  assert.match(retrieval.results[0].parentContent, /Remote state/);
  assert.ok(Array.isArray(retrieval.results[0].neighbors));

  const vietnamese = index.retrieve({ query: 'khóa trạng thái', tags: ['vietnamese'] });
  assert.equal(vietnamese.results[0].documentId, 'doc-vietnamese');

  const browserDocument = record('doc-browser', 'Browser import', 'A browser-side chunk keeps its original stable citation identifier.');
  browserDocument.data.chunks = [{ id: 'chunk-0', index: 0, start: 0, end: browserDocument.data.content.length }];
  index.indexDocument(browserDocument);
  assert.equal(index.retrieve({ query: 'stable citation identifier', documentIds: ['doc-browser'] }).results[0].sourceSpanId, 'doc-browser:chunk-0');
});

test('runs one corrective pass and clearly refuses without evidence', () => {
  const broadened = index.retrieve({ query: 'locking nonexistentterm', limit: 2 });
  assert.equal(broadened.correctivePass, true);
  assert.ok(broadened.results.length > 0);
  const refused = index.retrieve({ query: 'zyxwvutsrqponmlkjihgfedcba' });
  assert.equal(refused.confidence, 'low');
  assert.match(refused.refusal, /sufficient indexed evidence/);
});

test('removes all derived chunks for a deleted document', () => {
  const removed = index.removeDocument('doc-vietnamese');
  assert.ok(removed.removedChunks > 0);
  assert.equal(index.retrieve({ query: 'khóa trạng thái', documentIds: ['doc-vietnamese'] }).results.length, 0);
});
