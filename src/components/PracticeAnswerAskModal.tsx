import type { QuizQuestion } from '../types';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { askPracticeAnswer } from '../utils/askPracticeAnswer';
import AskAIModal from './AskAIModal';

interface Props {
  question: QuizQuestion;
  questionNumber: number;
  userAnswers: string[];
  selfAssessment?: boolean;
  documentIds: string[];
  onClose: () => void;
}

export default function PracticeAnswerAskModal({ question, questionNumber, userAnswers, selfAssessment, documentIds, onClose }: Props) {
  const documents = useLiveQuery(() => db.documents.bulkGet(documentIds), [documentIds.join('|')])?.filter(document => document !== undefined) ?? [];
  return <AskAIModal title={`Ask AI about question ${questionNumber}`} onClose={onClose}
    scope={documents.map(document => ({ id: document.id, label: document.name }))}
    emptyMessage="Ask why an answer is correct, what you missed, or for another explanation."
    loadingMessage="Reviewing the answer…"
    ask={(prompt, provider, model, history, signal) => askPracticeAnswer(
      question, userAnswers, selfAssessment, prompt, provider, model, history, documents, signal,
    )} />;
}
