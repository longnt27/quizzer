import Dexie from 'dexie';
import type { GenerationOptions, QuestionType, QuizQuestion } from '../types';

export type GenerationJobStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'error' | 'completed' | 'cancelled';

export interface StoredGenerationJob {
  id: string;
  testId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  status: GenerationJobStatus;
  documentIds: string[];
  options: GenerationOptions;
  questions: QuizQuestion[];
  rejected: number;
  rounds: Partial<Record<QuestionType, number>>;
  progress?: {
    accepted: number;
    target: number;
    round: number;
    maxRounds: number;
    rejected: number;
    currentType?: QuestionType;
    typeAccepted: number;
    typeTarget: number;
    phase: 'requesting' | 'validating';
    provider: GenerationOptions['provider'];
    parallelRequests?: number;
  };
  error?: string;
  errorCode?: string;
  nextAttemptAt?: number;
  workerId?: string;
}

export interface StoredTest {
  id: string;
  name: string;
  createdAt: number;
  questions: QuizQuestion[];
  attempts: {
    id: string;
    time: number;
    duration: number;
    selectedAnswers: Record<number, string[]>;
    selfAssessments?: Record<number, boolean>;
    score: number;
  }[];
  fileContent?: string;
  documentIds?: string[];
  generationOptions?: GenerationOptions;
}

export interface StoredDocument {
  id: string;
  name: string;
  createdAt: number;
  mimeType: string;
  size: number;
  tags: string[];
  content: string;
  pageCount?: number;
  originalFile?: Blob;
  images?: { name: string; mimeType: string; data: string }[];
}

class QuizDB extends Dexie {
  tests: Dexie.Table<StoredTest, string>;
  documents: Dexie.Table<StoredDocument, string>;
  generationJobs: Dexie.Table<StoredGenerationJob, string>;

  constructor() {
    super('QuizDB');
    this.version(1).stores({
      tests: 'id, name, createdAt',
    });
    this.version(2).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
    });
    this.version(3).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
      generationJobs: 'id, status, createdAt, updatedAt, *documentIds',
    });
    this.tests = this.table('tests');
    this.documents = this.table('documents');
    this.generationJobs = this.table('generationJobs');
  }
}

export const db = new QuizDB();
