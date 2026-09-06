import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRagThresholds, evaluateRagCorpora, RAG_THRESHOLDS } from '../eval/rag/evaluator.mjs';

const corpusDirectory = fileURLToPath(new URL('../eval/rag/', import.meta.url));
const paths = (await readdir(corpusDirectory))
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => join(corpusDirectory, name));
const corpora = await Promise.all(paths.map(async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Could not read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`); }
}));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quizzer-rag-eval-'));

try {
  const result = evaluateRagCorpora(corpora, { databasePath: join(temporaryDirectory, 'rag.sqlite') });
  const percent = value => `${(value * 100).toFixed(1)}%`;
  process.stdout.write(`RAG corpora: ${result.counts.corpora} (${result.counts.answerableQueries} answerable, ${result.counts.unanswerableQueries} refusal)\n`);
  process.stdout.write(`Recall@10: ${percent(result.metrics.recallAt10)} (minimum ${percent(RAG_THRESHOLDS.recallAt10)})\n`);
  process.stdout.write(`Citation precision: ${percent(result.metrics.citationPrecision)} (minimum ${percent(RAG_THRESHOLDS.citationPrecision)})\n`);
  process.stdout.write(`Refusal accuracy: ${percent(result.metrics.refusalAccuracy)} (minimum ${percent(RAG_THRESHOLDS.refusalAccuracy)})\n`);
  assertRagThresholds(result);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
