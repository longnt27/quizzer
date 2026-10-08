import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, scoreRun, makeReviewPacket, compareReports } from '../eval/course-benchmark/evaluation.mjs';

const source = { id: 's1', family: 'course', split: 'dev', language: 'vi', pages: 20, url: 'https://users.soict.hust.edu.vn/a.pdf', catalogUrl: 'https://tailieuhust.com/a/', sha256: null };
const review = { status: 'candidate', author: 'ai', reviewer: null };
const positive = { id: 'r1', split: 'dev', documentIds: ['s1'], language: 'vi', query: 'q', answerable: true, referenceAnswer: 'a', evidence: [{ documentId: 's1', pages: [2, 3] }], category: 'multi-page', review };
const negative = { ...positive, id: 'r2', answerable: false, referenceAnswer: null, evidence: [], unanswerableReason: 'Missing parameter' };
const task = { id: 'g1', split: 'dev', documentIds: ['s1'], language: 'vi', prompt: 'Make questions', requested: 5, type: 'single-answer-mcq', review };
const dataset = { version: 'test', status: 'candidate', sources: [source], retrieval: [positive, negative], generation: [task] };
const lock = { version: 1, sources: [{ id: 's1', url: source.url, sha256: 'a'.repeat(64), bytes: 42 }] };
const system = { name: 'baseline', gitCommit: 'b'.repeat(40), generator: 'model@pinned', settingsFingerprint: 'c'.repeat(64) };
const options = { allowCandidate: true };
const hit = page => ({ documentId: 's1', page, sourceSpanId: `chunk-${page}` });
const question = id => ({ id, type: 'multiple-choice', statement: `Question ${id}?`, answer: [{ content: 'Yes', correct: true }, { content: 'No', correct: false }] });
const run = (track = 'retrieval', predictions = []) => createRun(dataset, { track, split: 'dev', sourceLock: lock, system, predictions });
const ready = packet => ({ ...packet, annotations: packet.annotations.map(a => ({ ...a, reviewer: 'Reviewer A', reviewedAt: '2026-10-08', correct: true, unambiguous: true, grounded: true, distractorsValid: true, instructionFollowed: true })) });

test('candidate scores require explicit opt-in and a complete source lock', () => {
  assert.throws(() => scoreRun(dataset, run()), /candidate/i);
  assert.throws(() => createRun(dataset, { track: 'retrieval', split: 'dev', sourceLock: { version: 1, sources: [] }, system }), /lock/i);
});
test('partial page recall differs from full evidence, rank and refusal', () => {
  const r = run('retrieval', [{ id: 'r1', status: 'ok', refused: false, results: [hit(9), hit(2)], elapsedMs: 10 }, { id: 'r2', status: 'ok', refused: true, results: [] }]);
  const m = scoreRun(dataset, r, options).metrics;
  assert.equal(m.pageRecallAt5, 0.5); assert.equal(m.pageMrrAt10, 0.5); assert.equal(m.completeEvidenceAt5, 0);
  assert.equal(m.correctRefusalRate, 1); assert.equal(m.falseRefusalRate, 0);
});
test('missing rows and errors stay in denominators and are never correct refusals', () => {
  const report = scoreRun(dataset, run('retrieval', [{ id: 'r2', status: 'error', refused: false, results: [] }]), options);
  assert.equal(report.metrics.pageRecallAt5, 0); assert.equal(report.metrics.correctRefusalRate, 0);
  assert.equal(report.counts.missing, 1); assert.equal(report.counts.errors, 1);
});
test('duplicate or foreign task predictions fail rather than changing sample counts', () => {
  assert.throws(() => scoreRun(dataset, run('retrieval', [{ id: 'other', status: 'error', results: [] }]), options), /prediction/);
  assert.throws(() => scoreRun(dataset, run('retrieval', [{ id: 'r1', status: 'error', results: [] }, { id: 'r1', status: 'error', results: [] }]), options), /prediction/);
});
test('invalid source locations and fake error refusals fail', () => {
  for (const results of [[{ ...hit(2), documentId: 'other' }], [hit(30)]]) {
    assert.throws(() => scoreRun(dataset, run('retrieval', [{ id: 'r1', status: 'ok', refused: false, results }]), options), /location/);
  }
  assert.throws(() => scoreRun(dataset, run('retrieval', [{ id: 'r2', status: 'error', refused: true, results: [] }]), options), /error/);
});
test('same evidence page cannot inflate recall when multiple chunks hit it', () => {
  const r = run('retrieval', [{ id: 'r1', status: 'ok', refused: false, results: [hit(2), { ...hit(2), sourceSpanId: 'another' }] }]);
  assert.equal(scoreRun(dataset, r, options).metrics.pageRecallAt5, 0.5);
});
test('a zero-denominator slice reports null, not perfect accuracy', () => {
  const report = scoreRun(dataset, run(), options);
  assert.equal(report.metrics.latencyP95Ms, null);
  assert.equal(report.slices.language.en, undefined);
});
test('dataset fingerprint mismatch is rejected', () => {
  assert.throws(() => scoreRun({ ...dataset, version: 'changed' }, run(), options), /fingerprint/);
});
test('generation validity and requested yield have different denominators', () => {
  const r = run('generation', [{ id: 'g1', status: 'ok', questions: [question('a'), question('b')] }]);
  const report = scoreRun(dataset, r, { ...options, reviews: ready(makeReviewPacket(dataset, r)) });
  assert.equal(report.metrics.deliveredValidity, 1); assert.equal(report.metrics.validQuestionYield, 0.4);
});
test('empty generation yields zero but has undefined delivered validity', () => {
  const r = run('generation');
  const report = scoreRun(dataset, r, { ...options, reviews: ready(makeReviewPacket(dataset, r)) });
  assert.equal(report.metrics.deliveredValidity, null); assert.equal(report.metrics.validQuestionYield, 0);
});
test('unreviewed questions cannot be dropped or treated as failures silently', () => {
  const r = run('generation', [{ id: 'g1', status: 'ok', questions: [question('a')] }]);
  assert.throws(() => scoreRun(dataset, r, { ...options, reviews: makeReviewPacket(dataset, r) }), /review/);
});
test('reviews bind to exact output bytes, not just question IDs', () => {
  const r = run('generation', [{ id: 'g1', status: 'ok', questions: [question('a')] }]);
  const reviews = ready(makeReviewPacket(dataset, r)); r.predictions[0].questions[0].statement = 'Changed';
  assert.throws(() => scoreRun(dataset, r, { ...options, reviews }), /fingerprint/);
});
test('mechanical MCQ invalidity overrides optimistic human labels', () => {
  const q = question('a'); q.answer[1].correct = true;
  const r = run('generation', [{ id: 'g1', status: 'ok', questions: [q] }]);
  assert.equal(scoreRun(dataset, r, { ...options, reviews: ready(makeReviewPacket(dataset, r)) }).metrics.deliveredValidity, 0);
});
test('normalized exact repeats and reviewed semantic duplicates earn no extra yield', () => {
  const q = question('a'); const r = run('generation', [{ id: 'g1', status: 'ok', questions: [q, { ...q, id: 'b' }, question('c')] }]);
  const reviews = ready(makeReviewPacket(dataset, r)); reviews.annotations[2].duplicateOf = 'a';
  const report = scoreRun(dataset, r, { ...options, reviews });
  assert.equal(report.counts.duplicates, 2); assert.equal(report.metrics.validQuestionYield, 0.2);
});
test('unknown or cyclic duplicate labels and duplicate annotations fail', () => {
  const r = run('generation', [{ id: 'g1', status: 'ok', questions: [question('a'), question('b')] }]);
  const reviews = ready(makeReviewPacket(dataset, r)); reviews.annotations[0].duplicateOf = 'b';
  assert.throws(() => scoreRun(dataset, r, { ...options, reviews }), /duplicate/);
  const duplicate = ready(makeReviewPacket(dataset, r)); duplicate.annotations.push(duplicate.annotations[0]);
  assert.throws(() => scoreRun(dataset, r, { ...options, reviews: duplicate }), /annotation/);
});
test('comparison refuses incompatible protocol or source snapshots', () => {
  const a = scoreRun(dataset, run(), options); const b = structuredClone(a); b.protocol.contextBudget = 999;
  assert.throws(() => compareReports(a, b), /protocol/);
  b.protocol = a.protocol; b.sourceFingerprint = 'x'; assert.throws(() => compareReports(a, b), /source/);
});
test('same-protocol comparisons expose deltas but no spurious confidence interval', () => {
  const a = scoreRun(dataset, run(), options); const b = structuredClone(a); b.metrics.pageRecallAt5 = 0.5;
  assert.equal(compareReports(a, b).deltas.pageRecallAt5, 0.5); assert.equal(compareReports(a, b).confidenceInterval, null);
});
test('CLI help is offline and unknown flags fail', async () => {
  const { spawnSync } = await import('node:child_process');
  const path = new URL('../scripts/evaluate-course-benchmark.mjs', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const help = spawnSync(process.execPath, [fileURLToPath(path), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /record-generation/);
  const bad = spawnSync(process.execPath, [fileURLToPath(path), '--auto-pay'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /Unknown flag/);
});
