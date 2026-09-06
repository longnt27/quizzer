import assert from 'node:assert/strict';
import test from 'node:test';
import { builtInRerank, maximalMarginalRelevance, rerankRetrieval } from '../server/reranking.mjs';

const result = (id, content, denseScore) => ({
  sourceSpanId: id, documentId: 'doc', content, excerpt: content, score: 0.01, denseScore,
});

test('combines rank, lexical, and dense signals in the built-in reranker', () => {
  const ranked = builtInRerank('terraform state', [
    result('weak', 'unrelated apples', 0.1),
    result('strong', 'Terraform remote state', 0.95),
  ]);
  assert.equal(ranked[0].sourceSpanId, 'strong');
  assert.ok(ranked[0].rerankScore > ranked[1].rerankScore);
});

test('uses maximal marginal relevance to prefer a diverse next passage', () => {
  const first = result('first', 'apple fruit orchard');
  const duplicate = result('duplicate', 'apple fruit orchard');
  const diverse = result('diverse', 'terraform network state');
  const selected = maximalMarginalRelevance([first, duplicate, diverse], { lambda: 0.5 });
  assert.deepEqual(selected.map(item => item.sourceSpanId), ['first', 'diverse', 'duplicate']);
  assert.throws(() => maximalMarginalRelevance({}, { lambda: 0.5 }), /must be an array/);
  assert.throws(() => maximalMarginalRelevance([], { lambda: 2 }), /from 0 to 1/);
});

test('accepts versioned plugin rankings and appends omitted candidates', async () => {
  const results = [result('first', 'one'), result('second', 'two'), result('third', 'three')];
  const reranked = await rerankRetrieval({
    query: 'query', results, enabled: true, component: 'dev.reranker',
    invokePlugin: async (id, params) => {
      assert.equal(id, 'dev.reranker');
      assert.equal(params.candidates.length, 3);
      return { ranking: [{ sourceSpanId: 'second', score: 0.99 }, { sourceSpanId: 'first', score: 0.5 }] };
    },
  });
  assert.equal(reranked.metadata.status, 'ready');
  assert.equal(reranked.metadata.component, 'dev.reranker');
  assert.equal(reranked.metadata.diversity, 'maximal-marginal-relevance');
  assert.equal(reranked.results[0].sourceSpanId, 'second');
  assert.equal(reranked.results.find(item => item.sourceSpanId === 'second').rerankScore, 0.99);
  assert.ok(reranked.results.some(item => item.sourceSpanId === 'third'));
});

test('falls back locally for missing or malformed plugins but preserves cancellation', async () => {
  const results = [result('first', 'terraform state')];
  const missing = await rerankRetrieval({ query: 'terraform', results, enabled: true, component: 'missing' });
  assert.equal(missing.metadata.status, 'fallback');
  assert.match(missing.metadata.issue, /No plugin runtime/);

  const malformed = await rerankRetrieval({
    query: 'terraform', results, enabled: true, component: 'malformed', invokePlugin: async () => ({ ranking: [
      { sourceSpanId: 'first' }, { sourceSpanId: 'first' },
    ] }),
  });
  assert.equal(malformed.metadata.status, 'fallback');
  assert.match(malformed.metadata.issue, /unknown or duplicate/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(rerankRetrieval({
    query: 'terraform', results, enabled: true, component: 'slow', signal: controller.signal,
    invokePlugin: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  }), error => error.name === 'AbortError');
  assert.deepEqual((await rerankRetrieval({ query: 'x', results, enabled: false })).results, results);
  await assert.rejects(rerankRetrieval({ query: 1, results }), /query and retrieval results/);
});
