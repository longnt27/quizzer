export interface QuizAnswer {
  correct: boolean;
  content: string;
  explanation: string;
}

export interface MultipleChoiceQuestion {
  type?: 'multiple-choice';
  statement: string;
  answer: QuizAnswer[];
}

export interface FillBlankQuestion {
  type: 'fill-blank';
  statement: string;
  acceptedAnswers: string[];
  explanation: string;
}

export interface ReasoningQuestion {
  type: 'reasoning';
  statement: string;
  referenceAnswer: string;
  explanation: string;
}

export type QuizQuestion = MultipleChoiceQuestion | FillBlankQuestion | ReasoningQuestion;
export type QuestionType = 'multiple-choice' | 'fill-blank' | 'reasoning';

export interface AIConversationTurn {
  question: string;
  answer: string;
}

export interface QuestionCounts {
  multipleChoice: number;
  fillBlank: number;
  reasoning: number;
}

export type GenerationProvider =
  | 'codex'
  | 'claude-agent'
  | 'antigravity-agent'
  | 'gemini'
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'deepseek';

export interface GenerationOptions {
  provider: GenerationProvider;
  model?: string;
  questionCount: number;
  questionCounts?: QuestionCounts;
  multipleChoiceMode?: 'single' | 'multiple' | 'mixed';
}

export interface TestSession {
  mode: 'taking' | 'reviewing';
  testId: string;
  timeLimit?: number;
  startedAt?: number;
  options?: {
    instantFeedback: boolean;
  };
}
