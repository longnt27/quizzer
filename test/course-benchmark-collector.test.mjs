import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRetrieval } from '../eval/course-benchmark/service-collector.mjs';

const source = { id: 's1', split: 'dev', pages: 4, url: 'https://users.soict.hust.edu.vn/a.pdf', sha256: null };
const dataset = { version: '1', status: 'candidate', sources: [source], retrieval: [{ id: 'r1', split: 'dev', documentIds: ['s1'], language: 'vi', query: 'Question', referenceAnswer: 'GOLD', evidence: [{ documentId: 's1', pages: [2] }] }] };
const sourceLock = { version: 1, sources: [{ id: 's1', url: source.url, sha256: 'a'.repeat(64), bytes: 99 }] };
const config = { baseUrl: 'http://127.0.0.1:8787', split: 'dev', documentMap: { s1: 'runtime-id' }, system: { name: 'full', gitCommit: 'b'.repeat(40) } };
const options = { token: 'PRIVATE', sourceLock, allowCandidate: true, acknowledgeProviderAccess: true };
function fetcher({ badHash = false, failure = false, foreign = false, settingsChanged = false } = {}) {
  let reads = 0;
  return async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer PRIVATE');
    if (url.endsWith('/settings')) return Response.json({ values: { 'retrieval.mode': settingsChanged && reads++ ? 'changed' : 'hybrid' } });
    if (url.includes('/documents/')) return Response.json({ document: { id: 'runtime-id', originalFile: { sha256: (badHash ? 'z' : 'a').repeat(64) }, parserVersion: 'v1', content: 'SOURCE TEXT', chunks: [{ id: 'c', page: 2 }] } });
    const body = JSON.parse(init.body);
    assert.deepEqual(body.documentIds, ['runtime-id']); assert.equal(body.query, 'Question');
    assert.equal(body.limit, 10); assert.equal(body.includeNeighbors, false);
    assert.ok(!init.body.includes('GOLD') && !init.body.includes('evidence'));
    if (failure) return new Response('SECRET ERROR', { status: 500 });
    return Response.json({ method: 'hybrid-rrf', confidence: 'high', dense: { status: 'ready', embeddingModel: 'v1' }, results: [{ documentId: foreign ? 'other' : 'runtime-id', sourceSpanId: 'c', page: 2, content: 'SOURCE TEXT' }] });
  };
}
test('collector calls the production API with scoped inputs and emits no source text or token', async () => {
  const run = await collectRetrieval(dataset, config, { ...options, fetcher: fetcher() });
  assert.equal(run.predictions[0].results[0].documentId, 's1');
  assert.equal(run.predictions[0].results[0].page, 2);
  assert.equal(run.predictions[0].method, 'hybrid-rrf');
  assert.ok(!JSON.stringify(run).includes('PRIVATE') && !JSON.stringify(run).includes('SOURCE TEXT') && !JSON.stringify(run).includes('GOLD'));
});
test('no remote access without consent, or off-loopback token transmission', async () => {
  await assert.rejects(collectRetrieval(dataset, config, { ...options, acknowledgeProviderAccess: false }), /acknowledge/);
  await assert.rejects(collectRetrieval(dataset, { ...config, baseUrl: 'https://example.org' }, options), /loopback/);
  await assert.rejects(collectRetrieval(dataset, { ...config, baseUrl: 'http://127.0.0.1:8787/?secret=x' }, options), /loopback/);
});
test('candidate inputs require explicit acknowledgement before API calls', async () => {
  await assert.rejects(collectRetrieval(dataset, config, { ...options, allowCandidate: false }), /candidate/i);
});
test('source mismatch fails preflight instead of producing benchmark results', async () => {
  await assert.rejects(collectRetrieval(dataset, config, { ...options, fetcher: fetcher({ badHash: true }) }), /hash/);
});
test('missing document map fails rather than using the whole user library', async () => {
  await assert.rejects(collectRetrieval(dataset, { ...config, documentMap: {} }, options), /mapping/);
});
test('API failures retain the task but redact response bodies', async () => {
  const run = await collectRetrieval(dataset, config, { ...options, fetcher: fetcher({ failure: true }) });
  assert.equal(run.predictions.length, 1); assert.equal(run.predictions[0].status, 'error');
  assert.equal(run.predictions[0].refused, false); assert.ok(!JSON.stringify(run).includes('SECRET ERROR'));
});
test('out-of-scope response evidence becomes an explicit task error', async () => {
  const run = await collectRetrieval(dataset, config, { ...options, fetcher: fetcher({ foreign: true }) });
  assert.equal(run.predictions[0].status, 'error'); assert.deepEqual(run.predictions[0].results, []);
});
test('changing settings during a run aborts mixed-configuration reporting', async () => {
  await assert.rejects(collectRetrieval(dataset, config, { ...options, fetcher: fetcher({ settingsChanged: true }) }), /settings changed/);
});
