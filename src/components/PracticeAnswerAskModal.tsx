import type { QuizQuestion } from '../types';
import { askPracticeAnswer } from '../utils/askPracticeAnswer';
import AskAIModal from './AskAIModal';

interface Props {
  question: QuizQuestion;
  questionNumber: number;
  userAnswers: string[];
  selfAssessment?: boolean;
  onClose: () => void;
}

export default function PracticeAnswerAskModal({ question, questionNumber, userAnswers, selfAssessment, onClose }: Props) {
  return <AskAIModal title={`Ask AI about question ${questionNumber}`} onClose={onClose}
    emptyMessage="Ask why an answer is correct, what you missed, or for another explanation."
    loadingMessage="Reviewing the answer…"
    ask={(prompt, provider, model, history, signal) => askPracticeAnswer(
      question, userAnswers, selfAssessment, prompt, provider, model, history, signal,
    )} />;
}
