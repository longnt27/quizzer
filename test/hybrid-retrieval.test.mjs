import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHybridRetrieval, reciprocalRankFusion } from '../server/hybrid-retrieval.mjs';

const sparseResult = (id, content = id.repeat(8)) => ({
  sourceSpanId: id, documentId: 'doc', documentName: 'Guide', documentVersionHash: 'version', chunkIndex: 0,
  parentId: 'parent', content, excerpt: content, score: 0.1, bm25: -1, neighbors: [], parentContent: content,
});
const denseResult = (id, score, excerpt = id.repeat(8)) => ({
  sourceSpanId: id, documentId: 'doc', documentName: 'Guide', documentVersionHash: 'version', chunkIndex: 0,
  parentId: 'parent', excerpt, score,
});

test('reciprocal rank fusion rewards evidence returned by both channels', () => {
  const fused = reciprocalRankFusion([
    [sparseResult('shared'), sparseResult('sparse')],
    [denseResult('dense', 0.9), denseResult('shared', 0.8), denseResult('shared', 0.7)],
  ]);
  assert.equal(fused[0].sourceSpanId, 'shared');
  assert.deepEqual(fused[0].channels, [0, 1]);
  assert.equal(fused.filter(result => result.sourceSpanId === 'shared').length, 1);
  assert.throws(() => reciprocalRankFusion([{}]), /rankings must be arrays/);
  assert.throws(() => reciprocalRankFusion([], { k: 0 }), /positive integer/);
});

test('builds token-budgeted hybrid results with stable citations and channel metadata', () => {
  const sparse = {
    query: 'state protection', method: 'sparse-bm25', correctivePass: true, confidence: 'medium',
    results: [sparseResult('shared', 'short evidence'), sparseResult('sparse-only', 'x'.repeat(2_000))],
  };
  const preview = buildHybridRetrieval({
    sparse,
    denseResults: [denseResult('dense-only', 0.9, 'semantic evidence'), denseResult('shared', 0.8), denseResult('noise', 0.2)],
    limit: 4,
    contextBudget: 256,
  });
  assert.equal(preview.method, 'hybrid-rrf');
  assert.equal(preview.confidence, 'high');
  assert.equal(preview.correctivePass, true);
  assert.equal(preview.results[0].sourceSpanId, 'shared');
  assert.deepEqual(preview.results[0].retrievalChannels, ['sparse', 'dense']);
  assert.ok(preview.results.some(result => result.sourceSpanId === 'dense-only'));
  assert.ok(!preview.results.some(result => result.sourceSpanId === 'noise'));
  assert.ok(!preview.results.some(result => result.sourceSpanId === 'sparse-only'));
});

test('keeps a clear refusal when neither channel has sufficient evidence', () => {
  const sparse = { query: 'unknown', correctivePass: false, confidence: 'low', results: [] };
  const empty = buildHybridRetrieval({ sparse, denseResults: [] });
  assert.equal(empty.confidence, 'low');
  assert.match(empty.refusal, /could not find sufficient/);
  const weak = buildHybridRetrieval({ sparse, denseResults: [denseResult('weak', 0.4)] });
  assert.equal(weak.confidence, 'low');
  assert.match(weak.refusal, /could not find sufficient/);
  assert.throws(() => buildHybridRetrieval({ sparse: {}, denseResults: [] }), /required/);
});
