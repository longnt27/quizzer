import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const DEFAULT_DATASET = fileURLToPath(new URL('./v1/', import.meta.url));
export const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unique = list => new Set(list).size === list.length;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function review(record) {
  ensure(record.review && ['candidate', 'reviewed'].includes(record.review.status), `${record.id}: review status required`);
  ensure(nonempty(record.review.author), `${record.id}: annotation author required`);
  if (record.review.status === 'reviewed') {
    ensure(nonempty(record.review.reviewer) && record.review.reviewer !== 'ai'
      && /^\d{4}-\d{2}-\d{2}$/.test(record.review.reviewedAt ?? ''), `${record.id}: human review needs reviewer and review date`);
  }
}

export function validateDataset(dataset) {
  ensure(dataset && nonempty(dataset.version) && ['candidate', 'reviewed'].includes(dataset.status), 'Dataset identity/status required');
  for (const key of ['sources', 'retrieval', 'generation']) ensure(Array.isArray(dataset[key]) && dataset[key].length, `${key} must not be empty`);
  const sources = new Map();
  const families = new Map();
  for (const source of dataset.sources) {
    ensure(nonempty(source.id) && !sources.has(source.id), 'Missing or duplicate source id');
    ensure(nonempty(source.family) && ['dev', 'test'].includes(source.split), `${source.id}: family/split required`);
    ensure(!families.has(source.family) || families.get(source.family) === source.split, `${source.id}: source family leaks across splits`);
    ensure(Number.isInteger(source.pages) && source.pages > 0, `${source.id}: positive page count required`);
    ensure(['vi', 'en'].includes(source.language), `${source.id}: source language required`);
    for (const key of ['url', 'catalogUrl']) {
      const url = new URL(source[key]);
      ensure(url.protocol === 'https:' && !url.username && !url.password, `${source.id}: HTTPS ${key} required`);
    }
    ensure(source.sha256 === null || /^[a-f0-9]{64}$/.test(source.sha256), `${source.id}: invalid source fingerprint`);
    sources.set(source.id, source); families.set(source.family, source.split);
  }
  const ids = new Set();
  for (const track of ['retrieval', 'generation']) for (const record of dataset[track]) {
    ensure(nonempty(record.id) && !ids.has(record.id), 'Missing or duplicate task id'); ids.add(record.id);
    ensure(['dev', 'test'].includes(record.split), `${record.id}: invalid split`);
    ensure(['vi', 'en'].includes(record.language), `${record.id}: invalid language`);
    ensure(Array.isArray(record.documentIds) && record.documentIds.length && unique(record.documentIds), `${record.id}: invalid documentIds`);
    for (const id of record.documentIds) ensure(sources.has(id) && sources.get(id).split === record.split, `${record.id}: unknown source or cross-split documentIds`);
    review(record);
    if (dataset.status === 'reviewed') ensure(record.review.status === 'reviewed', 'Dataset cannot claim reviewed while candidates remain');
    if (track === 'generation') {
      ensure(nonempty(record.prompt) && record.type === 'single-answer-mcq' && Number.isInteger(record.requested)
        && record.requested > 0 && record.requested <= 20, `${record.id}: invalid generation request`);
      continue;
    }
    ensure(nonempty(record.query) && typeof record.answerable === 'boolean' && nonempty(record.category), `${record.id}: invalid retrieval case`);
    ensure(Array.isArray(record.evidence), `${record.id}: evidence array required`);
    if (!record.answerable) {
      ensure(record.referenceAnswer === null && record.evidence.length === 0 && nonempty(record.unanswerableReason), `${record.id}: unanswerable case must have no answer/evidence and explain why`);
    } else {
      ensure(nonempty(record.referenceAnswer) && record.evidence.length > 0, `${record.id}: answerable case needs answer/evidence`);
      const evidenceKeys = new Set();
      for (const evidence of record.evidence) {
        ensure(record.documentIds.includes(evidence.documentId) && Array.isArray(evidence.pages) && evidence.pages.length > 0
          && unique(evidence.pages), `${record.id}: invalid evidence scope/pages`);
        for (const page of evidence.pages) {
          const key = `${evidence.documentId}:${page}`;
          ensure(Number.isInteger(page) && page >= 1 && page <= sources.get(evidence.documentId).pages && !evidenceKeys.has(key), `${record.id}: duplicate or out-of-range evidence page`);
          evidenceKeys.add(key);
        }
      }
    }
  }
  return dataset;
}

export function projectInput(record) {
  const common = { id: record.id, documentIds: [...record.documentIds], language: record.language };
  return Object.hasOwn(record, 'query') ? { ...common, query: record.query }
    : { ...common, prompt: record.prompt, requested: record.requested, type: record.type };
}

export async function readJsonLines(path) {
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { throw new Error(`${path}:${index + 1}: invalid JSON`); }
  });
}

export async function loadDataset(directory = DEFAULT_DATASET) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  return validateDataset({ ...manifest,
    sources: JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8')),
    retrieval: await readJsonLines(join(directory, 'retrieval.jsonl')),
    generation: await readJsonLines(join(directory, 'generation.jsonl')),
  });
}
