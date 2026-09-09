import type { GenerationRejection } from '../db/db';
import type { QuestionType } from '../types';

const typeLabels: Record<QuestionType, string> = {
  'multiple-choice': 'Multiple choice',
  'fill-blank': 'Fill in the blank',
  reasoning: 'Reasoning',
  coding: 'Coding',
};

const reasonLabels: Record<GenerationRejection['reason'], string> = {
  'invalid-schema': 'The response did not match the required question format',
  ungrounded: 'The question was not supported strongly enough by the selected source',
  'instruction-mismatch': 'The question did not follow its custom instructions',
  duplicate: 'The question was too similar to one already accepted',
  'empty-response': 'The provider returned no candidate questions',
  'out-of-coverage': 'The provider returned more candidates than the assigned source slots',
  'missing-blank': 'The statement did not contain exactly one five-underscore blank (_____)',
  'accepted-answer-count': 'The question did not provide 3–16 accepted answers',
  'invalid-accepted-answer': 'One or more accepted answers were empty or invalid',
  'duplicate-accepted-answer': 'Accepted answers became duplicates after normalization',
  'missing-explanation': 'The question did not include an explanation',
};

export interface GenerationRejectionSummary {
  key: string;
  type: QuestionType;
  typeLabel: string;
  reason: GenerationRejection['reason'];
  reasonLabel: string;
  count: number;
}

export const summarizeGenerationRejections = (rejections: GenerationRejection[] = []): GenerationRejectionSummary[] => {
  const grouped = new Map<string, GenerationRejectionSummary>();
  for (const rejection of rejections) {
    const key = `${rejection.type}:${rejection.reason}`;
    const current = grouped.get(key);
    if (current) current.count += rejection.count;
    else grouped.set(key, {
      key,
      type: rejection.type,
      typeLabel: typeLabels[rejection.type],
      reason: rejection.reason,
      reasonLabel: reasonLabels[rejection.reason],
      count: rejection.count,
    });
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count
    || left.typeLabel.localeCompare(right.typeLabel) || left.reasonLabel.localeCompare(right.reasonLabel));
};
