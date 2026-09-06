import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertRagThresholds, evaluateRagCorpora, RAG_THRESHOLDS } from '../eval/rag/evaluator.mjs';

const readCorpus = async name => JSON.parse(await readFile(new URL(`../eval/rag/${name}.json`, import.meta.url), 'utf8'));

test('meets bilingual retrieval, citation, and refusal quality gates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-rag-evaluation-test-'));
  try {
    const result = evaluateRagCorpora(await Promise.all([readCorpus('en'), readCorpus('vi')]), {
      databasePath: join(directory, 'rag.sqlite'),
    });
    assert.equal(result.counts.corpora, 2);
    assert.equal(result.counts.answerableQueries, 10);
    assert.equal(result.counts.unanswerableQueries, 4);
    assert.doesNotThrow(() => assertRagThresholds(result));
    for (const [metric, threshold] of Object.entries(RAG_THRESHOLDS)) {
      assert.ok(result.metrics[metric] >= threshold, `${metric} must meet its published threshold`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports every failed RAG metric together', () => {
  assert.throws(() => assertRagThresholds({
    metrics: { recallAt10: 0.5, citationPrecision: 0.75, refusalAccuracy: 0.25 },
  }), /recallAt10 50\.0%.*citationPrecision 75\.0%.*refusalAccuracy 25\.0%/);
});
