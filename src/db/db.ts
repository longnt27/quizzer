import Dexie from 'dexie';
import type { CoverageStrategy, GenerationOptions, QuestionType, QuizAnswer, QuizQuestion } from '../types';
import type { ReasoningJudgment } from '../utils/judgeReasoning';

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
  coveragePlan?: StoredCoveragePlan;
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
    reasoningJudgments?: Record<number, ReasoningJudgment>;
    questionOrder?: number[];
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
  images?: StoredDocumentImage[];
  chunks?: StoredDocumentChunk[];
}

export interface StoredDocumentImage {
  id?: string;
  name: string;
  mimeType: string;
  data: string;
  page?: number;
  sourceStart?: number;
  caption?: string;
  context?: string;
  ocrText?: string;
}

export interface StoredDocumentChunk {
  id: string;
  index: number;
  page?: number;
  start: number;
  end: number;
}

export interface StoredCoveragePlan {
  strategy: CoverageStrategy;
  createdAt: number;
  slots: Array<{
    documentIds: string[];
    chunkIndexes: Record<string, number>;
  }>;
}

export interface StoredTestDraft {
  testId: string;
  updatedAt: number;
  startedAt: number;
  pausedAt?: number;
  timeLimit?: number;
  practice: boolean;
  currentIndex: number;
  questionOrder?: number[];
  answers: Record<number, string[]>;
  selfAssessments: Record<number, boolean>;
  revealedReasoning: Record<number, boolean>;
  submittedQuestions: Record<number, boolean>;
  reviewMarks: Record<number, boolean>;
  shuffledAnswers: Record<number, QuizAnswer[]>;
}

export type SyncCollection = 'tests' | 'documents' | 'generationJobs' | 'testDrafts';

export interface StoredSyncChange {
  key: string;
  collection: SyncCollection;
  id: string;
  deleted: boolean;
  changedAt: number;
}

export interface StoredSyncState {
  id: 'server';
  cursor: number;
  bootstrapped: boolean;
}

class QuizDB extends Dexie {
  tests: Dexie.Table<StoredTest, string>;
  documents: Dexie.Table<StoredDocument, string>;
  generationJobs: Dexie.Table<StoredGenerationJob, string>;
  testDrafts: Dexie.Table<StoredTestDraft, string>;
  syncChanges: Dexie.Table<StoredSyncChange, string>;
  syncState: Dexie.Table<StoredSyncState, string>;

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
    this.version(4).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
      generationJobs: 'id, status, createdAt, updatedAt, *documentIds',
      testDrafts: 'testId, updatedAt',
    });
    this.version(5).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
      generationJobs: 'id, status, createdAt, updatedAt, *documentIds',
      testDrafts: 'testId, updatedAt',
      syncChanges: 'key, collection, id, changedAt',
      syncState: 'id',
    });
    this.tests = this.table('tests');
    this.documents = this.table('documents');
    this.generationJobs = this.table('generationJobs');
    this.testDrafts = this.table('testDrafts');
    this.syncChanges = this.table('syncChanges');
    this.syncState = this.table('syncState');
  }
}

export const db = new QuizDB();
