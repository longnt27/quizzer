import Dexie from 'dexie';
import type { AIConversationTurn, CoverageStrategy, GenerationOptions, GenerationUsageAuditEntry, GenerationUsageSummary, HardwareProfileId, InterfaceMode, OnboardingState, PromptProfile, ProviderAttempt, QuestionType, QuizAnswer, QuizQuestion } from '../types';
import type { ReasoningJudgment } from '../utils/judgeReasoning';

export type GenerationJobStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'error' | 'completed' | 'cancelled';

export interface GenerationRejection {
  at: number;
  type: QuestionType;
  round: number;
  reason: 'invalid-schema' | 'ungrounded' | 'instruction-mismatch' | 'duplicate' | 'empty-response' | 'out-of-coverage'
    | 'missing-blank' | 'accepted-answer-count' | 'invalid-accepted-answer' | 'duplicate-accepted-answer' | 'missing-explanation';
  count: number;
  statement?: string;
}

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
  rejections?: GenerationRejection[];
  rounds: Partial<Record<QuestionType, number>>;
  coveragePlan?: StoredCoveragePlan;
  activeRouteIndex?: number;
  providerAttempts?: ProviderAttempt[];
  usageSummary?: GenerationUsageSummary;
  usageAudit?: GenerationUsageAuditEntry[];
  recoveryAttemptId?: string;
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
  leaseId?: string;
  leaseExpiresAt?: number;
  completionId?: string;
  creationFingerprint?: string;
}

export type IndexJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface StoredIndexJob {
  id: string;
  kind: 'index';
  status: IndexJobStatus;
  documentIds: string[];
  remainingDocumentIds: string[];
  completedDocumentIds: string[];
  results: Array<{
    id?: string;
    documentId?: string;
    name?: string;
    versionHash: string;
    chunks: number;
    reused: boolean;
  }>;
  force: boolean;
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  recoveredAt?: number;
  finishedAt?: number;
  error?: string;
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
  contentHash?: string;
  parserVersion?: string;
  extractionSchemaVersion?: number;
  extractedAt?: number;
  extractionContentHash?: string;
  chunkingVersion?: number;
  extractionHistory?: StoredExtractionRevision[];
  indexedAt?: number;
  indexVersion?: number;
  documentVersionHash?: string;
  denseIndex?: { model: string; dimension: number; versionHash: string };
  pageCount?: number;
  originalFile?: Blob | StoredObjectReference;
  images?: StoredDocumentImage[];
  chunks?: StoredDocumentChunk[];
}

export interface StoredExtractionRevision {
  parserVersion: string;
  extractionSchemaVersion: number;
  extractedAt: number;
  extractionContentHash: string;
}

export interface StoredObjectReference {
  __quizzerObject: true;
  algorithm: 'sha256';
  sha256: string;
  size: number;
  type?: string;
  name?: string;
  lastModified?: number;
}

export interface StoredDocumentImage {
  id?: string;
  name: string;
  mimeType: string;
  data?: string;
  object?: StoredObjectReference;
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
  textHash?: string;
  /** Structural metadata added by the bounded parent/child chunker. */
  parentId?: string;
  breadcrumb?: string;
  sectionKind?: 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'image';
  tokenCount?: number;
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
  aiConversations?: Record<number, AIConversationTurn[]>;
}

export type StoredPromptProfile = PromptProfile & { builtIn?: false };

export type SyncCollection = 'tests' | 'documents' | 'generationJobs' | 'indexJobs' | 'testDrafts' | 'profiles' | 'promptProfiles';

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
  migrationId?: string;
  migrationExpectedRecords?: number;
  migrationExpectedHash?: string;
}

export interface StoredAppProfile {
  id: 'default';
  createdAt: number;
  updatedAt: number;
  interfaceMode: InterfaceMode;
  hardwareProfile: HardwareProfileId;
  onboarding: OnboardingState;
  /** Retained for backward-compatible profile sync; new quizzes start with a blank per-test instruction. */
  defaultLearningInstruction?: string;
  upgradedExistingLibrary: boolean;
  whatsNewDismissedVersion?: number;
}

class QuizDB extends Dexie {
  tests: Dexie.Table<StoredTest, string>;
  documents: Dexie.Table<StoredDocument, string>;
  generationJobs: Dexie.Table<StoredGenerationJob, string>;
  indexJobs: Dexie.Table<StoredIndexJob, string>;
  testDrafts: Dexie.Table<StoredTestDraft, string>;
  syncChanges: Dexie.Table<StoredSyncChange, string>;
  syncState: Dexie.Table<StoredSyncState, string>;
  profiles: Dexie.Table<StoredAppProfile, string>;
  promptProfiles: Dexie.Table<StoredPromptProfile, string>;

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
    this.version(6).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
      generationJobs: 'id, status, createdAt, updatedAt, *documentIds',
      testDrafts: 'testId, updatedAt',
      syncChanges: 'key, collection, id, changedAt',
      syncState: 'id',
      profiles: 'id, updatedAt',
    });
    this.version(7).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
      generationJobs: 'id, status, createdAt, updatedAt, *documentIds',
      testDrafts: 'testId, updatedAt',
      syncChanges: 'key, collection, id, changedAt',
      syncState: 'id',
      profiles: 'id, updatedAt',
      promptProfiles: 'id, name, updatedAt',
    });
    this.version(8).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
      generationJobs: 'id, status, createdAt, updatedAt, *documentIds',
      indexJobs: 'id, status, createdAt, updatedAt, *documentIds',
      testDrafts: 'testId, updatedAt',
      syncChanges: 'key, collection, id, changedAt',
      syncState: 'id',
      profiles: 'id, updatedAt',
      promptProfiles: 'id, name, updatedAt',
    });
    this.tests = this.table('tests');
    this.documents = this.table('documents');
    this.generationJobs = this.table('generationJobs');
    this.indexJobs = this.table('indexJobs');
    this.testDrafts = this.table('testDrafts');
    this.syncChanges = this.table('syncChanges');
    this.syncState = this.table('syncState');
    this.profiles = this.table('profiles');
    this.promptProfiles = this.table('promptProfiles');
  }
}

export const db = new QuizDB();
