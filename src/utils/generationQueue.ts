import { db, type StoredGenerationJob } from '../db/db';
import type { GenerationOptions } from '../types';
import { generateQuiz, getGenerationErrorCode } from './api';

const workerId = crypto.randomUUID();
const active = new Map<string, AbortController>();
const concurrency = 1;
let recovering: Promise<void> | null = null;
let pumping = false;

const recoverInterruptedJobs = () => {
  if (!recovering) recovering = db.generationJobs.where('status').equals('running').toArray().then(async jobs => {
    const interrupted = jobs.filter(job => job.workerId !== workerId);
    await Promise.all(interrupted.map(job => db.generationJobs.update(job.id, {
      status: 'queued', workerId: undefined, error: 'Generation was interrupted and will resume from its last checkpoint.', updatedAt: Date.now(),
    })));
  });
  return recovering;
};

const claimNextJob = async (): Promise<StoredGenerationJob | undefined> => db.transaction('rw', db.generationJobs, async () => {
  const now = Date.now();
  const candidates = (await db.generationJobs.where('status').anyOf('queued', 'waiting').toArray())
    .filter(job => job.status === 'queued' || (navigator.onLine && (job.nextAttemptAt ?? 0) <= now))
    .sort((left, right) => left.createdAt - right.createdAt);
  const job = candidates[0];
  if (!job) return undefined;
  await db.generationJobs.update(job.id, { status: 'running', workerId, error: undefined, errorCode: undefined, updatedAt: now });
  return { ...job, status: 'running', workerId, error: undefined, errorCode: undefined, updatedAt: now };
});

const processJob = async (job: StoredGenerationJob) => {
  const controller = new AbortController();
  active.set(job.id, controller);
  try {
    const documents = await db.documents.bulkGet(job.documentIds);
    const available = documents.filter(document => document !== undefined);
    if (available.length !== job.documentIds.length) throw new Error('One or more source documents were deleted before generation completed.');
    const content = available.map(document => `# Document: ${document.name}\n\n${document.content}`).join('\n\n---\n\n');
    const images = available.flatMap(document => document.images?.map(image => `data:${image.mimeType};base64,${image.data}`) ?? []);
    const questions = await generateQuiz(
      content,
      job.options,
      controller.signal,
      progress => { void db.generationJobs.update(job.id, { progress, updatedAt: Date.now() }); },
      images,
      undefined,
      undefined,
      { questions: job.questions, rejected: job.rejected, rounds: job.rounds, options: job.options },
      checkpoint => db.generationJobs.update(job.id, {
        questions: checkpoint.questions,
        rejected: checkpoint.rejected,
        rounds: checkpoint.rounds,
        options: checkpoint.options,
        updatedAt: Date.now(),
      }).then(() => undefined),
    );
    const latest = await db.generationJobs.get(job.id);
    if (!latest || latest.status === 'cancelled') return;
    const finishedAt = Date.now();
    await db.transaction('rw', db.tests, db.generationJobs, async () => {
      await db.tests.put({
        id: job.testId,
        name: job.name,
        createdAt: finishedAt,
        questions,
        attempts: [],
        documentIds: job.documentIds,
        fileContent: content,
        generationOptions: latest.options,
      });
      await db.generationJobs.update(job.id, {
        status: 'completed', questions, finishedAt, updatedAt: finishedAt, workerId: undefined,
        progress: latest.progress ? { ...latest.progress, accepted: questions.length, phase: 'validating' } : undefined,
      });
    });
  } catch (error) {
    const latest = await db.generationJobs.get(job.id);
    if (!latest || latest.status === 'cancelled') return;
    const code = getGenerationErrorCode(error);
    if ((error as Error).name === 'AbortError') {
      await db.generationJobs.update(job.id, { status: 'cancelled', error: undefined, workerId: undefined, updatedAt: Date.now() });
    } else if (code === 'connection_lost') {
      await db.generationJobs.update(job.id, {
        status: 'waiting', error: (error as Error).message, errorCode: code,
        nextAttemptAt: Date.now() + 5_000, workerId: undefined, updatedAt: Date.now(),
      });
    } else if (code === 'provider_limit' || code === 'provider_auth' || code === 'provider_unavailable') {
      await db.generationJobs.update(job.id, {
        status: 'paused', error: (error as Error).message, errorCode: code, workerId: undefined, updatedAt: Date.now(),
      });
    } else {
      await db.generationJobs.update(job.id, {
        status: 'error', error: (error as Error).message, errorCode: code, workerId: undefined, updatedAt: Date.now(),
      });
    }
  } finally {
    active.delete(job.id);
    void pumpGenerationQueue();
  }
};

export const pumpGenerationQueue = async () => {
  if (pumping) return;
  pumping = true;
  try {
    await recoverInterruptedJobs();
    while (active.size < concurrency && navigator.onLine) {
      const job = await claimNextJob();
      if (!job || active.has(job.id)) break;
      void processJob(job);
    }
  } finally {
    pumping = false;
  }
};

export const cancelGenerationJob = async (id: string) => {
  await db.generationJobs.update(id, { status: 'cancelled', workerId: undefined, finishedAt: Date.now(), updatedAt: Date.now() });
  active.get(id)?.abort();
};

export const retryGenerationJob = async (id: string) => {
  await db.generationJobs.update(id, {
    status: 'queued', rounds: {}, error: undefined, errorCode: undefined, nextAttemptAt: undefined, workerId: undefined, updatedAt: Date.now(),
  });
  void pumpGenerationQueue();
};

export const resumeGenerationJob = async (id: string, options: GenerationOptions) => {
  await db.generationJobs.update(id, {
    status: 'queued', options, error: undefined, errorCode: undefined, nextAttemptAt: undefined, workerId: undefined, updatedAt: Date.now(),
  });
  void pumpGenerationQueue();
};

export const removeGenerationJob = (id: string) => db.generationJobs.delete(id);
