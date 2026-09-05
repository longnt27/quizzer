import { db, type StoredGenerationJob } from '../db/db';
import type { GenerationOptions, QuestionType } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { generateQuiz, getGenerationErrorCode, getRequestedCounts } from './api';
import { getGenerationConcurrency } from './generationSettings';
import { buildCoveragePlan, ensureDocumentChunks, retrievalContextForSlots } from './sourcePlanning';
import { syncNow } from '../db/serverSync';
import type { ProviderAttempt, ProviderRoute } from '../types';
import { serviceJson } from './serviceApi';

const workerId = uuidv4();
const active = new Map<string, AbortController>();
let pumping = false;

const claimNextJob = async (): Promise<StoredGenerationJob | undefined> => {
  await syncNow();
  const { job } = await serviceJson<{ job?: StoredGenerationJob }>('/api/v1/jobs/claim', 'POST', { workerId, leaseMs: 45_000 });
  if (job) await db.generationJobs.put(job);
  return job;
};

const processJob = async (job: StoredGenerationJob) => {
  const controller = new AbortController();
  active.set(job.id, controller);
  let leaseLost = false;
  let renewing = false;
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
      : [{ provider: job.options.provider, model: job.options.model, privacy: 'remote-api', paid: true, approved: true }];
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
      await db.generationJobs.update(job.id, { coveragePlan, updatedAt: Date.now() });
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
      progress => { void db.generationJobs.update(job.id, { progress, updatedAt: Date.now() }); },
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
          await db.generationJobs.update(job.id, { providerAttempts, updatedAt: Date.now() });
          return null;
        }
        routeIndex = nextRouteIndex;
        const route = routeChain[routeIndex];
        const replacement = { ...job.options, provider: route.provider, model: route.model, routeChain };
        await db.generationJobs.update(job.id, {
          options: replacement,
          activeRouteIndex: routeIndex,
          providerAttempts,
          updatedAt: Date.now(),
        });
        return replacement;
      },
      { questions: job.questions, rejected: job.rejected, rounds: job.rounds, options: job.options },
      checkpoint => db.generationJobs.update(job.id, {
        questions: checkpoint.questions,
        rejected: checkpoint.rejected,
        rounds: checkpoint.rounds,
        options: checkpoint.options,
        updatedAt: Date.now(),
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
        status: 'completed', questions, finishedAt, updatedAt: finishedAt, workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined,
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
      });
    });
    await syncNow();
  } catch (error) {
    const latest = await db.generationJobs.get(job.id);
    if (!latest || latest.status === 'cancelled') return;
    const code = getGenerationErrorCode(error);
    if ((error as Error).name === 'AbortError') {
      if (leaseLost) await syncNow();
      else await db.generationJobs.update(job.id, {
        status: 'cancelled', error: undefined, workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
      });
    } else if (code === 'connection_lost') {
      await db.generationJobs.update(job.id, {
        status: 'waiting', error: (error as Error).message, errorCode: code,
        nextAttemptAt: Date.now() + 5_000, workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
      });
    } else if (code === 'provider_limit' || code === 'provider_auth' || code === 'provider_unavailable') {
      await db.generationJobs.update(job.id, {
        status: 'paused', error: (error as Error).message, errorCode: code,
        workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
      });
    } else {
      await db.generationJobs.update(job.id, {
        status: 'error', error: (error as Error).message, errorCode: code,
        workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
      });
    }
  } finally {
    window.clearInterval(leaseTimer);
    active.delete(job.id);
    void pumpGenerationQueue();
  }
};

export const pumpGenerationQueue = async () => {
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
  await db.generationJobs.update(id, {
    status: 'cancelled', workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined, finishedAt: Date.now(), updatedAt: Date.now(),
  });
  active.get(id)?.abort();
};

export const retryGenerationJob = async (id: string) => {
  await db.generationJobs.update(id, {
    status: 'queued', rounds: {}, error: undefined, errorCode: undefined, nextAttemptAt: undefined,
    workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
  });
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
  await db.generationJobs.update(id, {
    status: 'queued', options, activeRouteIndex: routeIndex, providerAttempts,
    error: undefined, errorCode: undefined, nextAttemptAt: undefined,
    workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined, updatedAt: Date.now(),
  });
  void pumpGenerationQueue();
};

export const removeGenerationJob = (id: string) => db.generationJobs.delete(id);
