import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDataset, projectInput, fingerprint } from '../eval/course-benchmark/dataset.mjs';

function fixture() {
  return {
    version: '0.1.0', status: 'candidate',
    sources: [{ id: 's1', family: 'a', split: 'dev', language: 'vi', pages: 12, url: 'https://example.org/a.pdf', catalogUrl: 'https://tailieuhust.com/a/', sha256: null }],
    retrieval: [{ id: 'r1', split: 'dev', documentIds: ['s1'], language: 'vi', query: 'Which mechanism?', answerable: true, referenceAnswer: 'A mechanism', evidence: [{ documentId: 's1', pages: [2, 4] }], category: 'multi-page', review: { status: 'candidate', author: 'ai', reviewer: null } }],
    generation: [{ id: 'g1', split: 'dev', documentIds: ['s1'], language: 'vi', prompt: 'Create a quiz.', requested: 5, type: 'single-answer-mcq', review: { status: 'candidate', author: 'ai', reviewer: null } }],
  };
}
test('valid candidate data is accepted without invented source pins', () => { assert.doesNotThrow(() => validateDataset(fixture())); });
test('source-family leakage fails', () => { const d = fixture(); d.sources.push({ ...d.sources[0], id: 's2', split: 'test' }); assert.throws(() => validateDataset(d), /family/); });
test('duplicate task identifiers fail', () => { const d = fixture(); d.retrieval.push(d.retrieval[0]); assert.throws(() => validateDataset(d), /duplicate/i); });
test('out-of-range and out-of-scope evidence fail', () => {
  for (const evidence of [[{ documentId: 's1', pages: [13] }], [{ documentId: 'missing', pages: [2] }]]) {
    const d = fixture(); d.retrieval[0].evidence = evidence; assert.throws(() => validateDataset(d), /evidence/);
  }
});
test('answerability and evidence must agree', () => { const d = fixture(); d.retrieval[0].answerable = false; assert.throws(() => validateDataset(d), /unanswerable/); });
test('human-reviewed status needs an actual reviewer and dated review', () => { const d = fixture(); d.retrieval[0].review.status = 'reviewed'; assert.throws(() => validateDataset(d), /review/); });
test('cross-split inputs fail even with valid source identifiers', () => { const d = fixture(); d.retrieval[0].split = 'test'; assert.throws(() => validateDataset(d), /split/); });
test('empty collections and repeated scope identifiers fail', () => {
  const d = fixture(); d.retrieval = []; assert.throws(() => validateDataset(d), /retrieval/);
  const e = fixture(); e.retrieval[0].documentIds.push('s1'); assert.throws(() => validateDataset(e), /documentIds/);
});
test('model-facing projection cannot leak gold answers, pages or review notes', () => {
  const r = fixture().retrieval[0]; r.notes = 'SECRET';
  assert.deepEqual(projectInput(r), { id: 'r1', documentIds: ['s1'], language: 'vi', query: 'Which mechanism?' });
  const g = fixture().generation[0]; g.referenceAnswer = 'SECRET';
  assert.deepEqual(projectInput(g), { id: 'g1', documentIds: ['s1'], language: 'vi', prompt: 'Create a quiz.', requested: 5, type: 'single-answer-mcq' });
});
test('fingerprint is stable under object key order, not under content changes', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});
test('published candidate pilot has complete attribution and balanced query languages', async () => {
  const { loadDataset } = await import('../eval/course-benchmark/dataset.mjs');
  const d = await loadDataset();
  assert.equal(d.sources.length, 10); assert.equal(d.retrieval.length, 60); assert.equal(d.generation.length, 20);
  assert.equal(d.retrieval.filter(r => r.answerable).length, 40);
  assert.equal(d.retrieval.filter(r => r.language === 'vi').length, 30);
  assert.equal(d.retrieval.filter(r => r.language === 'en').length, 30);
  assert.ok(d.sources.every(s => s.catalogUrl.startsWith('https://tailieuhust.com/') && s.inspection && s.mirrorEquivalence));
  assert.ok([...d.retrieval, ...d.generation].every(r => r.review.status === 'candidate'));
});
