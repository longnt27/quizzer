import type { QuestionCounts, QuestionType, QuizQuestion } from '../types';

export const getQuestionType = (question: QuizQuestion): QuestionType => question.type ?? 'multiple-choice';

export const normalizeWrittenAnswer = (value: string) => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const isQuestionCorrect = (question: QuizQuestion, answers: string[] = [], selfAssessment?: boolean) => {
  const type = getQuestionType(question);
  if (type === 'multiple-choice' && 'answer' in question) {
    const correct = question.answer.filter(answer => answer.correct).map(answer => answer.content).sort();
    return JSON.stringify(correct) === JSON.stringify([...answers].sort());
  }
  if (type === 'fill-blank' && 'acceptedAnswers' in question) {
    const response = normalizeWrittenAnswer(answers[0] ?? '');
    return Boolean(response) && question.acceptedAnswers.some(answer => normalizeWrittenAnswer(answer) === response);
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
