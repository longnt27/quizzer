import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessQuestionQuality, instructionTopicTerms, qualityTerms, retrievalNeedsCorrection,
} from '../server/generation-quality.mjs';

const evidence = [{
  content: 'Terraform state locking grants one writer exclusive ownership while the protected update is committed.',
  neighbors: [{ content: 'The lease is always released in a finally block.' }],
}];
const grounded = {
  type: 'multiple-choice',
  statement: 'Which Terraform mechanism prevents conflicting state writes?',
  answer: [
    { correct: true, content: 'Acquire the state lease', explanation: 'Exclusive ownership serializes writers.' },
    { correct: false, content: 'Delete the state', explanation: 'Deletion does not coordinate writers.' },
    { correct: false, content: 'Retry blindly', explanation: 'Retries can repeat the conflict.' },
  ],
};

test('scores source grounding and scoped custom instructions', () => {
  const result = assessQuestionQuality(grounded, evidence, 'Coding questions about Terraform only');
  assert.equal(result.accepted, true);
  assert.ok(result.groundingScore > 0);
  assert.ok(result.sharedTerms.includes('terraform'));
  assert.ok(result.instructionMatches.includes('terraform'));

  assert.deepEqual(assessQuestionQuality({
    ...grounded,
    statement: 'Which pigment absorbs sunlight?',
    answer: grounded.answer.map((answer, index) => ({
      ...answer,
      content: ['Chlorophyll', 'Hemoglobin', 'Keratin'][index],
      explanation: 'This biological substance has a different cellular role.',
    })),
  }, evidence, 'Biology only').reason, 'ungrounded');

  assert.deepEqual(assessQuestionQuality(grounded, evidence, 'Kubernetes only').reason, 'instruction-mismatch');
  assert.equal(assessQuestionQuality(grounded, evidence).accepted, true);
});

test('normalizes useful terms and identifies retrieval correction boundaries', () => {
  assert.deepEqual([...qualityTerms('Writers write updates and retries.')], ['writer', 'write', 'update', 'retry']);
  assert.deepEqual([...instructionTopicTerms('Answer in Vietnamese with short explanations.')], []);
  assert.deepEqual([...instructionTopicTerms('Terraform only')], ['terraform']);
  assert.equal(retrievalNeedsCorrection({ confidence: 'high', results: [{}] }), false);
  assert.equal(retrievalNeedsCorrection({ confidence: 'low', results: [{}] }), true);
  assert.equal(retrievalNeedsCorrection({ confidence: 'high', refusal: 'No evidence', results: [{}] }), true);
  assert.equal(retrievalNeedsCorrection({ confidence: 'high', results: [] }), true);
  assert.equal(retrievalNeedsCorrection(), true);
});
