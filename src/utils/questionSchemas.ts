import type { QuestionType } from '../types';

const multipleChoiceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'statement', 'answer'],
        properties: {
          type: { type: 'string', enum: ['multiple-choice'] },
          statement: { type: 'string' },
          answer: {
            type: 'array', minItems: 3, maxItems: 6,
            items: {
              type: 'object', additionalProperties: false,
              required: ['correct', 'content', 'explanation'],
              properties: {
                correct: { type: 'boolean' },
                content: { type: 'string' },
                explanation: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

const fillBlankSchema = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: {
    questions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'statement', 'acceptedAnswers', 'explanation'],
        properties: {
          type: { type: 'string', enum: ['fill-blank'] },
          statement: { type: 'string' },
          acceptedAnswers: { type: 'array', minItems: 3, maxItems: 16, items: { type: 'string' } },
          explanation: { type: 'string' },
        },
      },
    },
  },
};

const reasoningSchema = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: {
    questions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'statement', 'referenceAnswer', 'explanation'],
        properties: {
          type: { type: 'string', enum: ['reasoning'] },
          statement: { type: 'string' },
          referenceAnswer: { type: 'string' },
          explanation: { type: 'string' },
        },
      },
    },
  },
};

const codingSchema = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: {
    questions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'statement', 'referenceAnswer', 'explanation'],
        properties: {
          type: { type: 'string', enum: ['coding'] },
          statement: { type: 'string' },
          referenceAnswer: { type: 'string' },
          explanation: { type: 'string' },
        },
      },
    },
  },
};

export const generationQuestionSchemas: Record<QuestionType, object> = {
  'multiple-choice': multipleChoiceSchema,
  'fill-blank': fillBlankSchema,
  reasoning: reasoningSchema,
  coding: codingSchema,
};
