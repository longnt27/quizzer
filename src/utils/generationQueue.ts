import { db, type StoredGenerationJob, type StoredTest } from '../db/db';
import type { GenerationOptions, QuestionType } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { generateQuiz, getGenerationErrorCode, getRequestedCounts } from './api';
import { getGenerationConcurrency } from './generationSettings';
import { buildCoveragePlan, ensureDocumentChunks, retrievalContextForSlots } from './sourcePlanning';
import { applyServiceRecord, syncNow } from '../db/serverSync';
import type { ProviderAttempt, ProviderRoute } from '../types';
import { serviceJson } from './serviceApi';
import { getProviderRoute } from './providerSettings';

const workerId = uuidv4();
const rendererWorkerEnabled = import.meta.env.VITE_QUIZZER_RENDERER_WORKER === '1';
const active = new Map<string, AbortController>();
let pumping = false;
type WorkerJobPatch = Partial<Pick<StoredGenerationJob,
  'activeRouteIndex' | 'coveragePlan' | 'error' | 'errorCode' | 'nextAttemptAt' | 'options' |
  'progress' | 'providerAttempts' | 'questions' | 'rejected' | 'rounds' | 'status'>>;

const storeServiceJob = (job: StoredGenerationJob) => applyServiceRecord('generationJobs', job.id, job);

const claimNextJob = async (): Promise<StoredGenerationJob | undefined> => {
  await syncNow();
  const { job } = await serviceJson<{ job?: StoredGenerationJob }>('/api/v1/jobs/claim', 'POST', { workerId, leaseMs: 45_000 });
  if (job) await storeServiceJob(job);
  return job;
};

const processJob = async (job: StoredGenerationJob) => {
  const controller = new AbortController();
  active.set(job.id, controller);
  let leaseLost = false;
  let renewing = false;
  const persistPatch = async (patch: WorkerJobPatch) => {
    if (!job.leaseId || leaseLost) throw new Error('Generation lease is unavailable');
    try {
      const { job: saved } = await serviceJson<{ job: StoredGenerationJob }>(`/api/v1/jobs/${encodeURIComponent(job.id)}`, 'PATCH', {
        workerId, leaseId: job.leaseId, patch,
      });
      Object.assign(job, saved);
      await storeServiceJob(saved);
      return saved;
    } catch (error) {
      leaseLost = true;
      controller.abort();
      throw error;
    }
  };
  const renewLease = async () => {
    if (!job.leaseId || renewing || controller.signal.aborted) return;
    renewing = true;
    try {
      const { job: renewed } = await serviceJson<{ job: StoredGenerationJob }>(`/api/v1/jobs/${encodeURIComponent(job.id)}/lease`, 'POST', {
        workerId, leaseId: job.leaseId, leaseMs: 45_000,
      });
      job.leaseExpiresAt = renewed.leaseExpiresAt;
    } catch {
      leaseLost = true;
      controller.abort();
    } finally { renewing = false; }
  };
  const leaseTimer = window.setInterval(() => void renewLease(), 15_000);
  try {
    const routeChain: ProviderRoute[] = job.options.routeChain?.length
      ? job.options.routeChain
      : [getProviderRoute(job.options.provider, job.options.model, true)];
    let routeIndex = job.activeRouteIndex ?? Math.max(0, routeChain.findIndex(route => route.provider === job.options.provider && route.model === job.options.model));
    let providerAttempts: ProviderAttempt[] = [...(job.providerAttempts ?? [])];
    const documents = await db.documents.bulkGet(job.documentIds);
    const available = documents.filter(document => document !== undefined);
    if (available.length !== job.documentIds.length) throw new Error('One or more source documents were deleted before generation completed.');
    const chunkedDocuments = available.map(ensureDocumentChunks);
    await Promise.all(chunkedDocuments.map((document, index) => available[index].chunks?.length
      ? Promise.resolve()
      : db.documents.update(document.id, { chunks: document.chunks }).then(() => undefined)));
    const counts = getRequestedCounts(job.options);
    const target = counts.multipleChoice + counts.fillBlank + counts.reasoning + counts.coding;
    const strategy = job.options.coverageStrategy ?? 'balanced';
    let coveragePlan = job.coveragePlan;
    if (!coveragePlan || coveragePlan.strategy !== strategy || coveragePlan.slots.length !== target) {
      coveragePlan = (await buildCoveragePlan(chunkedDocuments, target, strategy, controller.signal)).plan;
      await persistPatch({ coveragePlan });
    }
    await syncNow();
    const offsets: Record<QuestionType, number> = {
      'multiple-choice': 0,
      'fill-blank': counts.multipleChoice,
      reasoning: counts.multipleChoice + counts.fillBlank,
      coding: counts.multipleChoice + counts.fillBlank + counts.reasoning,
    };
    const content = available.map(document => `# Document: ${document.name}\n\n${document.content}`).join('\n\n---\n\n');
    const questions = await generateQuiz(
      content,
      job.options,
      controller.signal,
      progress => persistPatch({ progress }).then(() => undefined),
      [],
      undefined,
      async failure => {
        providerAttempts = [...providerAttempts, {
          provider: failure.provider,
          model: routeChain[routeIndex]?.model,
          routeIndex,
          at: Date.now(),
          accepted: failure.accepted,
          outcome: 'failed',
          errorCode: failure.code,
          message: failure.message,
        }];
        const nextRouteIndex = routeChain.findIndex((route, index) => index > routeIndex && route.approved);
        if (nextRouteIndex < 0) {
          await persistPatch({ providerAttempts });
          return null;
        }
        routeIndex = nextRouteIndex;
        const route = routeChain[routeIndex];
        const replacement = { ...job.options, provider: route.provider, model: route.model, routeChain };
        await persistPatch({
          options: replacement,
          activeRouteIndex: routeIndex,
          providerAttempts,
        });
        return replacement;
      },
      { questions: job.questions, rejected: job.rejected, rounds: job.rounds, options: job.options },
      checkpoint => persistPatch({
        questions: checkpoint.questions,
        rejected: checkpoint.rejected,
        rounds: checkpoint.rounds,
        options: checkpoint.options,
      }).then(() => undefined),
      request => retrievalContextForSlots(
        chunkedDocuments,
        coveragePlan!,
        offsets[request.type] + request.typeAccepted,
        request.count,
        { customInstruction: job.options.customInstruction, contextBudget: job.options.ragProfile?.contextBudget, signal: controller.signal },
      ),
    );
    const latest = await db.generationJobs.get(job.id);
    if (!latest || latest.status === 'cancelled') return;
    const finishedAt = Date.now();
    const test: StoredTest = {
      id: job.testId,
      name: job.name,
      createdAt: finishedAt,
      questions,
      attempts: [],
      documentIds: job.documentIds,
      fileContent: content,
      generationOptions: latest.options,
    };
    const completed = await serviceJson<{ job: StoredGenerationJob; test: StoredTest }>(`/api/v1/jobs/${encodeURIComponent(job.id)}/complete`, 'POST', {
      workerId, leaseId: job.leaseId, completionId: uuidv4(), test,
      patch: {
        questions,
        activeRouteIndex: routeIndex,
        providerAttempts: [...providerAttempts, {
          provider: latest.options.provider,
          model: latest.options.model,
          routeIndex,
          at: finishedAt,
          accepted: questions.length,
          outcome: 'completed',
        }],
        progress: latest.progress ? { ...latest.progress, accepted: questions.length, phase: 'validating' } : undefined,
      },
    });
    Object.assign(job, completed.job);
    await applyServiceRecord('tests', completed.test.id, completed.test);
    await storeServiceJob(completed.job);
  } catch (error) {
    const latest = await db.generationJobs.get(job.id);
    if (!latest || latest.status === 'cancelled') return;
    if (leaseLost) {
      await syncNow();
      return;
    }
    const code = getGenerationErrorCode(error);
    try {
      if ((error as Error).name === 'AbortError') {
        await persistPatch({ status: 'error', error: 'Generation was interrupted.', errorCode: 'cancelled' });
      } else if (code === 'connection_lost') {
        await persistPatch({
          status: 'waiting', error: (error as Error).message, errorCode: code,
          nextAttemptAt: Date.now() + 5_000,
        });
      } else if (code === 'provider_limit' || code === 'provider_auth' || code === 'provider_unavailable') {
        await persistPatch({ status: 'paused', error: (error as Error).message, errorCode: code });
      } else {
        await persistPatch({ status: 'error', error: (error as Error).message, errorCode: code });
      }
    } catch (persistenceError) {
      console.warn('Quizzer could not persist the generation failure because the worker lease was lost.', persistenceError);
      await syncNow();
    }
  } finally {
    window.clearInterval(leaseTimer);
    active.delete(job.id);
    void pumpGenerationQueue();
  }
};

export const pumpGenerationQueue = async () => {
  if (!rendererWorkerEnabled) return;
  if (pumping) return;
  pumping = true;
  try {
    while (navigator.onLine && active.size < getGenerationConcurrency()) {
      const job = await claimNextJob();
      if (!job || active.has(job.id)) break;
      void processJob(job);
    }
  } catch (error) {
    console.warn('Quizzer could not claim a generation job from the local service.', error);
  } finally {
    pumping = false;
  }
};

export const cancelGenerationJob = async (id: string) => {
  const { job } = await serviceJson<{ job: StoredGenerationJob }>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {});
  await storeServiceJob(job);
  active.get(id)?.abort();
};

export const retryGenerationJob = async (id: string) => {
  const { job } = await serviceJson<{ job: StoredGenerationJob }>(`/api/v1/jobs/${encodeURIComponent(id)}/resume`, 'POST', { resetRounds: true });
  await storeServiceJob(job);
  void pumpGenerationQueue();
};

export const resumeGenerationJob = async (id: string, options: GenerationOptions) => {
  const existing = await db.generationJobs.get(id);
  const routeIndex = Math.max(0, options.routeChain?.findIndex(route => route.provider === options.provider && route.model === options.model) ?? 0);
  const providerAttempts = [...(existing?.providerAttempts ?? []), {
    provider: options.provider,
    model: options.model,
    routeIndex,
    at: Date.now(),
    accepted: existing?.questions.length ?? 0,
    outcome: 'manually-selected' as const,
  }];
  const { job } = await serviceJson<{ job: StoredGenerationJob }>(`/api/v1/jobs/${encodeURIComponent(id)}/resume`, 'POST', {
    options, activeRouteIndex: routeIndex, providerAttempts,
  });
  await storeServiceJob(job);
  void pumpGenerationQueue();
};

export const removeGenerationJob = (id: string) => db.generationJobs.delete(id);
