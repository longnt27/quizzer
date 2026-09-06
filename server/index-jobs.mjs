import { randomUUID } from 'node:crypto';

const runnableStatuses = new Set(['queued', 'running']);
const terminalStatuses = new Set(['completed', 'cancelled']);
const idempotencyPattern = /^[A-Za-z0-9._-]{8,100}$/;

const timestamp = now => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid index job time');
  return value;
};

const uniqueDocumentIds = documentIds => {
  if (!Array.isArray(documentIds) || documentIds.length === 0 || documentIds.length > 10_000) {
    throw new Error('Index jobs require between 1 and 10,000 document ids');
  }
  if (documentIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('Index document ids must be non-empty strings');
  }
  return [...new Set(documentIds)];
};

const validateJob = job => {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id) {
    throw new Error('A valid index job is required');
  }
  if (!['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)) {
    throw new Error(`Invalid index job status: ${job.status}`);
  }
  uniqueDocumentIds(job.documentIds);
  return job;
};

const assertDependencies = dependencies => {
  for (const name of ['load', 'save', 'getDocument', 'indexDocument', 'updateDocument']) {
    if (typeof dependencies?.[name] !== 'function') throw new Error(`Index jobs require a ${name} function`);
  }
  if (dependencies.now !== undefined && typeof dependencies.now !== 'function') throw new Error('Index job time must be a function');
  if (dependencies.yieldControl !== undefined && typeof dependencies.yieldControl !== 'function') {
    throw new Error('Index job yielding must be a function');
  }
};

export const createIndexJob = ({ documentIds, force = false, idempotencyKey, now = Date.now, id = randomUUID() } = {}) => {
  const ids = uniqueDocumentIds(documentIds);
  if (typeof force !== 'boolean') throw new Error('Index force must be a boolean');
  if (typeof id !== 'string' || !id) throw new Error('Index job id is required');
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyPattern.test(idempotencyKey))) {
    throw new Error('Index idempotency keys must contain 8 to 100 letters, numbers, dots, underscores, or hyphens');
  }
  const createdAt = timestamp(now);
  return {
    id,
    kind: 'index',
    status: 'queued',
    documentIds: ids,
    remainingDocumentIds: [...ids],
    completedDocumentIds: [],
    results: [],
    force,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    createdAt,
    updatedAt: createdAt,
  };
};

export const recoverIndexJob = (input, now = Date.now) => {
  const job = validateJob(input);
  if (job.status !== 'running') return job;
  const recoveredAt = timestamp(now);
  return { ...job, status: 'queued', updatedAt: recoveredAt, recoveredAt };
};

export const cancelIndexJob = (input, now = Date.now) => {
  const job = validateJob(input);
  if (job.status === 'completed') throw new Error('A completed index job cannot be cancelled');
  if (job.status === 'cancelled') return job;
  const finishedAt = timestamp(now);
  return {
    ...job,
    status: 'cancelled',
    error: undefined,
    updatedAt: finishedAt,
    finishedAt,
  };
};

export const resumeIndexJob = (input, now = Date.now) => {
  const job = validateJob(input);
  if (job.status === 'running' || job.status === 'completed') {
    throw new Error(`A ${job.status} index job cannot be resumed`);
  }
  if (job.status === 'queued') return job;
  const updatedAt = timestamp(now);
  const completed = new Set(job.completedDocumentIds ?? []);
  return {
    ...job,
    status: 'queued',
    remainingDocumentIds: job.documentIds.filter(id => !completed.has(id)),
    error: undefined,
    finishedAt: undefined,
    updatedAt,
  };
};

export const runIndexJob = async (input, dependencies) => {
  const job = validateJob(input);
  assertDependencies(dependencies);
  if (terminalStatuses.has(job.status)) return job;
  if (!runnableStatuses.has(job.status)) throw new Error(`A ${job.status} index job must be resumed before it can run`);

  const now = dependencies.now ?? Date.now;
  const yieldControl = dependencies.yieldControl ?? (() => Promise.resolve());
  let current = {
    ...job,
    status: 'running',
    startedAt: job.startedAt ?? timestamp(now),
    finishedAt: undefined,
    error: undefined,
    updatedAt: timestamp(now),
  };

  try {
    current = await dependencies.save(current);
    while (current.remainingDocumentIds.length > 0) {
      current = await dependencies.load(job.id);
      if (!current) throw new Error(`Index job ${job.id} disappeared while running`);
      if (current.status === 'cancelled') return current;
      if (current.status !== 'running') throw new Error(`Index job ${job.id} changed to ${current.status} while running`);

      const documentId = current.remainingDocumentIds[0];
      const document = await dependencies.getDocument(documentId);
      if (!document) throw new Error(`Document not found while indexing: ${documentId}`);
      const result = await dependencies.indexDocument(document, { force: current.force });
      await dependencies.updateDocument(document, result);

      const latest = await dependencies.load(job.id);
      if (!latest) throw new Error(`Index job ${job.id} disappeared while checkpointing`);
      if (latest.status === 'cancelled') return latest;
      if (latest.status !== 'running') throw new Error(`Index job ${job.id} changed to ${latest.status} while checkpointing`);
      const completedDocumentIds = [...new Set([...(latest.completedDocumentIds ?? []), documentId])];
      current = await dependencies.save({
        ...latest,
        completedDocumentIds,
        remainingDocumentIds: latest.documentIds.filter(id => !completedDocumentIds.includes(id)),
        results: [...(latest.results ?? []).filter(item => item.documentId !== documentId), result],
        updatedAt: timestamp(now),
      });
      await yieldControl();
    }

    const latest = await dependencies.load(job.id);
    if (!latest) throw new Error(`Index job ${job.id} disappeared before completion`);
    if (latest.status === 'cancelled') return latest;
    const finishedAt = timestamp(now);
    current = await dependencies.save({
      ...latest,
      status: 'completed',
      remainingDocumentIds: [],
      error: undefined,
      updatedAt: finishedAt,
      finishedAt,
    });
    return current;
  } catch (error) {
    const latest = await dependencies.load(job.id);
    if (latest?.status === 'cancelled') return latest;
    const finishedAt = timestamp(now);
    await dependencies.save({
      ...(latest ?? current),
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: finishedAt,
      finishedAt,
    });
    throw error;
  }
};
