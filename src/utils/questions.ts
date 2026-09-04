import type { QuestionCounts, QuestionType, QuizQuestion } from '../types';

export const getQuestionType = (question: QuizQuestion): QuestionType => question.type ?? 'multiple-choice';

export const normalizeWrittenAnswer = (value: string) => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const answerParts = (value: string) => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .split(/\s*(?:\+|&|\/|,|;|\band\b|\bor\b|\bvà\b|\bva\b)\s*/u)
  .map(part => part.trim())
  .filter(Boolean);

const partTokens = (value: string) => value.match(/[\p{L}\p{N}]+/gu) ?? [];

const isConceptPartEquivalent = (response: string, accepted: string) => {
  const responseTokens = partTokens(response);
  const acceptedTokens = partTokens(accepted);
  if (!responseTokens.length || !acceptedTokens.length) return false;
  const shorter = responseTokens.length <= acceptedTokens.length ? responseTokens : acceptedTokens;
  const longer = responseTokens.length <= acceptedTokens.length ? acceptedTokens : responseTokens;
  return shorter.every((token, index) => token === longer[longer.length - shorter.length + index]);
};

export const isEquivalentWrittenAnswer = (response: string, accepted: string) => {
  if (normalizeWrittenAnswer(response) === normalizeWrittenAnswer(accepted)) return true;
  const responseParts = answerParts(response);
  const acceptedParts = answerParts(accepted);
  if (responseParts.length < 2 || responseParts.length !== acceptedParts.length) return false;
  const remaining = [...acceptedParts];
  return responseParts.every(part => {
    const match = remaining.findIndex(candidate => isConceptPartEquivalent(part, candidate));
    if (match < 0) return false;
    remaining.splice(match, 1);
    return true;
  });
};

export const isQuestionCorrect = (question: QuizQuestion, answers: string[] = [], selfAssessment?: boolean) => {
  const type = getQuestionType(question);
  if (type === 'multiple-choice' && 'answer' in question) {
    const correct = question.answer.filter(answer => answer.correct).map(answer => answer.content).sort();
    return JSON.stringify(correct) === JSON.stringify([...answers].sort());
  }
  if (type === 'fill-blank' && 'acceptedAnswers' in question) {
    const response = normalizeWrittenAnswer(answers[0] ?? '');
    return Boolean(response) && question.acceptedAnswers.some(answer => isEquivalentWrittenAnswer(answers[0] ?? '', answer));
  }
  return selfAssessment === true;
};

export const getQuestionAnswerTexts = (question: QuizQuestion): string[] => {
  if (getQuestionType(question) === 'multiple-choice' && 'answer' in question) return question.answer.map(answer => answer.content);
  if (getQuestionType(question) === 'fill-blank' && 'acceptedAnswers' in question) return question.acceptedAnswers;
  if ('referenceAnswer' in question) return [question.referenceAnswer];
  return [];
};

export const countQuestionTypes = (questions: QuizQuestion[]): QuestionCounts => questions.reduce<QuestionCounts>((counts, question) => {
  const type = getQuestionType(question);
  if (type === 'multiple-choice') counts.multipleChoice++;
  else if (type === 'fill-blank') counts.fillBlank++;
  else if (type === 'reasoning') counts.reasoning++;
  else counts.coding++;
  return counts;
}, { multipleChoice: 0, fillBlank: 0, reasoning: 0, coding: 0 });

export const totalQuestionCount = (counts: QuestionCounts) => counts.multipleChoice + counts.fillBlank + counts.reasoning + counts.coding;
