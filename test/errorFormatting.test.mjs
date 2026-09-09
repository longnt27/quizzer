import test from 'node:test';
import assert from 'node:assert';
import { formatError, formatErrorMessage } from '../src/utils/errorFormatting.ts';

test('formatError maps network errors to the affected service without exposing transport text', () => {
  const result = formatError(new Error('fetch failed: ECONNREFUSED 127.0.0.1:47831'), 'service');
  assert.deepStrictEqual(result, {
    problem: "Quizzer's local service is unavailable.",
    nextStep: 'Restart Quizzer, then try again.',
  });
  assert.doesNotMatch(`${result.problem} ${result.nextStep}`, /ECONNREFUSED|127\.0\.0\.1/i);
});

test('formatError sanitizes dense indexing network failures', () => {
  const result = formatError(new Error('Sparse indexing completed, but dense indexing with bge-m3 is unavailable: fetch failed'));
  assert.strictEqual(result.problem, 'Semantic search is unavailable.');
  assert.strictEqual(result.nextStep, 'Keyword search remains available. Check the embedding service and model in Plugins & models.');
});

test('formatError handles unmapped technical errors with generic message', () => {
  const result = formatError(new Error('SQLITE_ERROR: no such column: xyz'));
  assert.deepStrictEqual(result, {
    problem: 'Quizzer could not complete that action.',
    nextStep: 'Try again. If it keeps failing, restart Quizzer.',
  });
  assert.doesNotMatch(`${result.problem} ${result.nextStep}`, /SQLITE|column|xyz/i);
});

test('formatErrorMessage returns combined string', () => {
  const result = formatErrorMessage(new Error('429 provider_limit'), 'generation');
  assert.strictEqual(result, 'The AI provider limit was reached. Wait for the provider limit to reset or continue with another provider from Activity.');
});

test('formatError handles non-Error service payloads without leaking them', () => {
  const result = formatError({ code: 'INTERNAL', query: 'select * from secrets' }, 'storage');
  assert.deepStrictEqual(result, {
    problem: 'Quizzer could not save the latest changes.',
    nextStep: 'Keep Quizzer open; it will retry automatically.',
  });
});

test('formatError gives update verification failures a manual recovery path', () => {
  const result = formatError('Release manifest schema validation failed: artifacts[0].url must be a Quizzer GitHub Release URL', 'updater');
  assert.deepStrictEqual(result, {
    problem: 'Quizzer could not verify the available update.',
    nextStep: 'Try again later or download the release manually from the Quizzer GitHub Releases page.',
  });
});
