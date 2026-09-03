import Dexie from 'dexie';
import { QuizQuestion } from '../types';

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
  generationOptions?: {
    provider: 'codex' | 'gemini';
    model?: string;
    questionCount: number;
    questionCounts?: {
      multipleChoice: number;
      fillBlank: number;
      reasoning: number;
    };
  };
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

  constructor() {
    super('QuizDB');
    this.version(1).stores({
      tests: 'id, name, createdAt',
    });
    this.version(2).stores({
      tests: 'id, name, createdAt, *documentIds',
      documents: 'id, name, createdAt, *tags',
    });
    this.tests = this.table('tests');
    this.documents = this.table('documents');
  }
}

export const db = new QuizDB();
