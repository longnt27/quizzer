export interface QuizAnswer {
  correct: boolean;
  content: string;
  explanation: string;
}

export interface QuizQuestion {
  statement: string;
  answer: QuizAnswer[];
}

export type GenerationProvider = 'codex' | 'gemini';

export interface GenerationOptions {
  provider: GenerationProvider;
  model?: string;
  questionCount: number;
}

export interface TestSession {
  mode: 'taking' | 'reviewing';
  testId: string;
  options?: {
    instantFeedback: boolean;
  };
}
