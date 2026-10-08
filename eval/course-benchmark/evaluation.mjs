import { ensure, fingerprint } from './dataset.mjs';
import { verifySourceLock } from './sources.mjs';

export const PROTOCOL = Object.freeze({ limit: 10, contextBudget: 4096, includeNeighbors: false, evidenceUnit: 'physical-pdf-page' });
const ratio = (n, d) => d ? n / d : null;
const mean = values => ratio(values.reduce((a, b) => a + b, 0), values.length);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sourceFingerprint = lock => fingerprint([...lock.sources].sort((a, b) => a.id.localeCompare(b.id)));
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const gradeKeys = ['correct', 'unambiguous', 'grounded', 'distractorsValid', 'instructionFollowed'];

export function createRun(dataset, { track, split, sourceLock, system, predictions = [] }) {
  ensure(['retrieval', 'generation'].includes(track) && ['dev', 'test'].includes(split), 'Invalid track/split');
  verifySourceLock(dataset.sources, sourceLock);
  ensure(text(system?.name) && /^[a-f0-9]{40}$/.test(system.gitCommit)
    && /^[a-f0-9]{64}$/.test(system.settingsFingerprint), 'System name, exact gitCommit and settingsFingerprint required');
  if (track === 'generation') ensure(text(system.generator), 'Pinned generator identity required');
  return { version: 1, track, split, datasetFingerprint: fingerprint(dataset), sourceLock,
    system: { name: system.name, gitCommit: system.gitCommit, settingsFingerprint: system.settingsFingerprint,
      ...(track === 'generation' ? { generator: system.generator } : {}) },
    protocol: { ...PROTOCOL }, predictions };
}

function inspect(dataset, run) {
  ensure(run?.version === 1 && ['retrieval', 'generation'].includes(run.track), 'Invalid run');
  ensure(run.datasetFingerprint === fingerprint(dataset), 'Dataset fingerprint mismatch');
  ensure(fingerprint(run.protocol) === fingerprint(PROTOCOL), 'Unsupported protocol');
  createRun(dataset, run);
  const tasks = dataset[run.track].filter(row => row.split === run.split);
  ensure(tasks.length > 0 && Array.isArray(run.predictions), 'No tasks or missing predictions');
  const ids = new Set(tasks.map(row => row.id)); const predictions = new Map();
  for (const row of run.predictions) {
    ensure(ids.has(row.id) && !predictions.has(row.id), 'Unknown or duplicate prediction');
    ensure(['ok', 'error'].includes(row.status), 'Invalid prediction status');
    ensure(row.elapsedMs === undefined || Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0, 'Invalid latency');
    predictions.set(row.id, row);
  }
  return { tasks, predictions };
}

function questions(row) {
  if (!row) return [];
  ensure(Array.isArray(row.questions), 'Generation prediction needs questions array, including on error');
  ensure(row.questions.length <= 100, 'Too many delivered questions');
  const ids = new Set();
  for (const q of row.questions) {
    ensure(text(q?.id) && !ids.has(q.id), 'Missing or duplicate question id'); ids.add(q.id);
  }
  return row.questions;
}

export function makeReviewPacket(dataset, run) {
  ensure(run.track === 'generation', 'Reviews are for generation runs');
  const { tasks, predictions } = inspect(dataset, run);
  return { version: 1, runFingerprint: fingerprint(run), annotations: tasks.flatMap(task =>
    questions(predictions.get(task.id)).map(question => ({ taskId: task.id, questionId: question.id,
      question, instruction: task.prompt, documentIds: task.documentIds, reviewer: null, reviewedAt: null,
      ...Object.fromEntries(gradeKeys.map(key => [key, null])), duplicateOf: null, notes: '' }))) };
}

function reviewIndex(run, packet) {
  ensure(packet?.version === 1 && packet.runFingerprint === fingerprint(run), 'Review run fingerprint mismatch');
  ensure(Array.isArray(packet.annotations), 'Review annotations required');
  const result = new Map();
  for (const a of packet.annotations) {
    const key = JSON.stringify([a.taskId, a.questionId]);
    ensure(!result.has(key), 'Duplicate annotation');
    ensure(text(a.reviewer) && !['ai', 'llm'].includes(a.reviewer.toLowerCase())
      && /^\d{4}-\d{2}-\d{2}$/.test(a.reviewedAt ?? '')
      && gradeKeys.every(k => typeof a[k] === 'boolean'), 'Incomplete human review');
    ensure(a.duplicateOf === null || text(a.duplicateOf), 'Invalid duplicate label');
    result.set(key, a);
  }
  return result;
}

function mcqShape(q) {
  return q.type === 'multiple-choice' && text(q.statement) && Array.isArray(q.answer) && q.answer.length >= 2
    && q.answer.every(a => text(a?.content) && typeof a.correct === 'boolean')
    && new Set(q.answer.map(a => normalize(a.content))).size === q.answer.length
    && q.answer.filter(a => a.correct).length === 1;
}

function summarize(rows, track) {
  const counts = { tasks: rows.length, missing: rows.filter(r => r.missing).length, errors: rows.filter(r => r.error).length };
  let metrics;
  if (track === 'retrieval') {
    const yes = rows.filter(r => r.answerable); const no = rows.filter(r => !r.answerable);
    counts.answerable = yes.length; counts.unanswerable = no.length;
    metrics = { pageRecallAt5: mean(yes.map(r => r.recall)), pageMrrAt10: mean(yes.map(r => r.mrr)),
      completeEvidenceAt5: mean(yes.map(r => Number(r.complete))),
      correctRefusalRate: ratio(no.filter(r => r.refused).length, no.length),
      falseRefusalRate: ratio(yes.filter(r => r.refused).length, yes.length) };
  } else {
    for (const key of ['requested', 'delivered', 'valid', 'validUnique', 'duplicates']) counts[key] = rows.reduce((n, r) => n + r[key], 0);
    metrics = { deliveredValidity: ratio(counts.valid, counts.delivered), validQuestionYield: ratio(counts.validUnique, counts.requested),
      duplicateRate: ratio(counts.duplicates, counts.delivered) };
  }
  const latency = rows.flatMap(r => r.elapsedMs === undefined ? [] : [r.elapsedMs]).sort((a, b) => a - b);
  counts.latencySamples = latency.length;
  metrics.latencyP50Ms = latency.length ? latency[Math.ceil(latency.length * 0.5) - 1] : null;
  metrics.latencyP95Ms = latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null;
  return { counts, metrics };
}

export function scoreRun(dataset, run, { allowCandidate = false, reviews } = {}) {
  const { tasks, predictions } = inspect(dataset, run);
  const candidate = dataset.status !== 'reviewed' || tasks.some(t => t.review.status !== 'reviewed');
  ensure(allowCandidate || !candidate, 'Candidate dataset requires --allow-candidate; results are exploratory');
  const labels = run.track === 'generation' ? reviewIndex(run, reviews) : null;
  const used = new Set();
  const rows = tasks.map(task => {
    const prediction = predictions.get(task.id);
    const row = { id: task.id, language: task.language, category: task.category ?? 'generation',
      documentIds: task.documentIds, missing: !prediction, error: prediction?.status === 'error', elapsedMs: prediction?.elapsedMs };
    if (run.track === 'retrieval') {
      const results = prediction?.results ?? [];
      ensure(Array.isArray(results) && results.length <= PROTOCOL.limit, 'Invalid retrieval results');
      if (prediction) ensure(typeof prediction.refused === 'boolean', 'Explicit retrieval refusal required');
      if (row.error) ensure(!prediction.refused && results.length === 0, 'Retrieval error cannot count as refusal or evidence');
      for (const result of results) {
        const source = dataset.sources.find(s => s.id === result.documentId);
        ensure(source && task.documentIds.includes(result.documentId) && text(result.sourceSpanId)
          && (result.page === null || Number.isInteger(result.page) && result.page >= 1 && result.page <= source.pages), 'Invalid retrieved location');
      }
      const gold = new Set(task.evidence.flatMap(e => e.pages.map(p => `${e.documentId}:${p}`)));
      const found = new Set(results.slice(0, 5).map(r => `${r.documentId}:${r.page}`).filter(k => gold.has(k)));
      const first = results.findIndex(r => gold.has(`${r.documentId}:${r.page}`));
      return { ...row, answerable: task.answerable, refused: prediction?.status === 'ok' && prediction.refused,
        recall: gold.size ? found.size / gold.size : null, mrr: first < 0 ? 0 : 1 / (first + 1), complete: gold.size > 0 && found.size === gold.size };
    }
    const delivered = questions(prediction); const previous = new Set(); const stems = new Set();
    let valid = 0; let validUnique = 0; let duplicates = 0;
    for (const q of delivered) {
      const key = JSON.stringify([task.id, q.id]); const a = labels.get(key);
      ensure(a, 'Missing question review'); used.add(key);
      ensure(a.duplicateOf === null || previous.has(a.duplicateOf), 'A duplicate must refer to an earlier question in this task');
      const normalized = typeof q.statement === 'string' ? normalize(q.statement) : '';
      const duplicate = a.duplicateOf !== null || normalized.length > 0 && stems.has(normalized);
      const accepted = mcqShape(q) && gradeKeys.every(k => a[k]);
      valid += Number(accepted); duplicates += Number(duplicate); validUnique += Number(accepted && !duplicate);
      previous.add(q.id); if (normalized) stems.add(normalized);
    }
    return { ...row, requested: task.requested, delivered: delivered.length, valid,
      validUnique: Math.min(task.requested, validUnique), duplicates };
  });
  if (labels) ensure(labels.size === used.size, 'Unknown or extra annotation');
  const slices = {};
  for (const field of ['language', 'category']) slices[field] = Object.fromEntries([...new Set(rows.map(r => r[field]))]
    .map(value => [value, summarize(rows.filter(r => r[field] === value), run.track)]));
  return { version: 1, track: run.track, split: run.split, exploratory: candidate, datasetFingerprint: run.datasetFingerprint,
    sourceFingerprint: sourceFingerprint(run.sourceLock), system: run.system, protocol: run.protocol,
    runFingerprint: fingerprint(run), ...summarize(rows, run.track), slices, details: rows,
    warning: 'Page relevance is not citation entailment. Human labels are attestations. No population confidence interval is claimed for this pilot.' };
}

export function compareReports(baseline, candidate) {
  for (const key of ['track', 'split', 'datasetFingerprint', 'sourceFingerprint']) ensure(baseline[key] === candidate[key], `Incompatible ${key}`);
  ensure(fingerprint(baseline.protocol) === fingerprint(candidate.protocol), 'Incompatible protocol');
  ensure(fingerprint(baseline.details.map(r => r.id)) === fingerprint(candidate.details.map(r => r.id)), 'Unpaired tasks');
  if (baseline.track === 'generation') ensure(baseline.system.generator === candidate.system.generator, 'Different generators');
  return { baseline: baseline.system.name, candidate: candidate.system.name, exploratory: baseline.exploratory || candidate.exploratory,
    tasks: baseline.counts.tasks, deltas: Object.fromEntries(Object.keys(baseline.metrics).map(k => [k,
      baseline.metrics[k] === null || candidate.metrics[k] === null ? null : candidate.metrics[k] - baseline.metrics[k]])),
    confidenceInterval: null, warning: 'Differences are candidate minus baseline, in fraction units (or milliseconds for latency). Same-model metadata is not proof of matched prompts, retry budgets or cost; inspect raw runs.' };
}
