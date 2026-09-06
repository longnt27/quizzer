import assert from 'node:assert/strict';
import test from 'node:test';
import { validateQuestionCheckpoint } from '../server/question-validation.mjs';

const provenance = { documentIds: ['doc-1'], sourceSpanIds: ['doc-1:span:0:abc'], provider: 'codex' };
const questions = [
  {
    type: 'multiple-choice', statement: 'Which state behavior protects collaborators?', provenance,
    answer: [
      { correct: true, content: 'Lock before writes', explanation: 'This serializes state changes safely.' },
      { correct: false, content: 'Delete before writes', explanation: 'Deletion loses the shared state.' },
      { correct: false, content: 'Ignore all writes', explanation: 'Ignoring writes cannot update state.' },
    ],
  },
  {
    type: 'fill-blank', statement: 'Terraform _____ protects concurrent state updates.',
    acceptedAnswers: ['locking', 'state locking', 'lock'], explanation: 'A lock serializes state updates.', provenance,
  },
  {
    type: 'reasoning', statement: 'Explain why remote state needs locking.',
    referenceAnswer: 'Remote state needs locking so concurrent writers cannot overwrite each other.',
    explanation: 'The answer should connect concurrency with state integrity.', provenance,
  },
  {
    type: 'coding', statement: 'Write a safe state update workflow.',
    referenceAnswer: 'Acquire the state lock, apply the update, persist it, and release the lock.',
    explanation: 'The lock must cover the complete read-modify-write transaction.', provenance,
  },
];
const job = {
  documentIds: ['doc-1'],
  options: {
    ragProfile: { id: 'balanced' }, multipleChoiceMode: 'single',
    questionCounts: { multipleChoice: 1, fillBlank: 1, reasoning: 1, coding: 1 },
  },
};

test('accepts schema-valid, source-grounded modern question checkpoints', () => {
  assert.equal(validateQuestionCheckpoint(questions, job), questions);
  assert.deepEqual(validateQuestionCheckpoint([{ statement: 'Legacy saved question' }], { options: {} }).length, 1);
});

test('rejects ungrounded, out-of-scope, and excessive modern checkpoints', () => {
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[0], provenance: undefined }], job), /provenance is required/);
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[0], provenance: {
    documentIds: ['other-doc'], sourceSpanIds: ['other-doc:span:0'],
  } }], job), /invalid document ids/);
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[0], provenance: {
    documentIds: ['doc-1'], sourceSpanIds: ['other-doc:span:0'],
  } }], job), /invalid source-span ids/);
  assert.throws(() => validateQuestionCheckpoint([questions[0], questions[0]], job), /exceeds the multiple-choice/);
});

test('enforces each protected output schema at the service boundary', () => {
  assert.throws(() => validateQuestionCheckpoint('questions', job), /array of at most 200/);
  assert.throws(() => validateQuestionCheckpoint([null], job), /invalid question/);
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[0], hidden: true }], job), /unsupported fields/);
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[0], answer: questions[0].answer.slice(0, 2) }], job), /3-6 answers/);
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[0], answer: questions[0].answer.map(answer => ({ ...answer, correct: true })) }], job), /correct and incorrect/);
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[1], acceptedAnswers: ['lock', 'LOCK', 'locking'] }], job), /must be unique/);
  assert.throws(() => validateQuestionCheckpoint([{ ...questions[2], referenceAnswer: 'too short' }], job), /reasoning question fields/);
  assert.throws(() => validateQuestionCheckpoint(questions, { ...job, options: { ...job.options, questionCounts: {} } }), /invalid expected question counts/);
});
