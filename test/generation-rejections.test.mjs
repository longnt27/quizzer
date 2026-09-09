import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeGenerationRejections } from '../src/utils/generationRejections.ts';

test('groups durable rejection events into user-facing explanations', () => {
  assert.deepEqual(summarizeGenerationRejections([
    { at: 1, type: 'fill-blank', round: 1, reason: 'missing-blank', count: 2 },
    { at: 2, type: 'fill-blank', round: 2, reason: 'missing-blank', count: 1 },
    { at: 3, type: 'fill-blank', round: 2, reason: 'accepted-answer-count', count: 1 },
  ]), [
    {
      key: 'fill-blank:missing-blank', type: 'fill-blank', typeLabel: 'Fill in the blank',
      reason: 'missing-blank', reasonLabel: 'The statement did not contain exactly one five-underscore blank (_____)', count: 3,
    },
    {
      key: 'fill-blank:accepted-answer-count', type: 'fill-blank', typeLabel: 'Fill in the blank',
      reason: 'accepted-answer-count', reasonLabel: 'The question did not provide 3–16 accepted answers', count: 1,
    },
  ]);
});
