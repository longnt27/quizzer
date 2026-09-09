import test from 'node:test';
import assert from 'node:assert';
import { formatError, formatErrorMessage } from '../src/utils/errorFormatting.ts';

test('formatError sanitizes network errors', () => {
  const result = formatError(new Error('fetch failed'));
  assert.strictEqual(result.problem, 'Could not connect to the network.');
  assert.strictEqual(result.nextStep, 'Please check your internet connection and try again.');
});

test('formatError sanitizes dense indexing network failures', () => {
  const result = formatError(new Error('Sparse indexing completed, but dense indexing with bge-m3 is unavailable: fetch failed'));
  assert.strictEqual(result.problem, 'Advanced semantic search is temporarily unavailable.');
  assert.strictEqual(result.nextStep, 'Keyword search remains available. Verify your configured local embedding service/model in Plugins & models.');
});

test('formatError handles unmapped technical errors with generic message', () => {
  const result = formatError(new Error('SQLITE_ERROR: no such column: xyz'));
  assert.strictEqual(result.problem, 'An unexpected issue occurred.');
  assert.strictEqual(result.nextStep, 'Please try your action again.');
});

test('formatErrorMessage returns combined string', () => {
  const result = formatErrorMessage(new Error('fetch failed'));
  assert.strictEqual(result, 'Could not connect to the network. Please check your internet connection and try again.');
});
