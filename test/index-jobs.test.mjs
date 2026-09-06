import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelIndexJob, createIndexJob, recoverIndexJob, resumeIndexJob, runIndexJob,
} from '../server/index-jobs.mjs';

const sequenceClock = (...values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

const memoryRunner = (initial, { failOn, onYield } = {}) => {
  let stored = structuredClone(initial);
  const indexed = [];
  return {
    indexed,
    current: () => structuredClone(stored),
    dependencies: {
      load: async () => structuredClone(stored),
      save: async job => {
        stored = structuredClone(job);
        return structuredClone(stored);
      },
      getDocument: async id => ({ id, data: { id, content: `Content for ${id}` } }),
      indexDocument: async document => {
        indexed.push(document.id);
        if (document.id === failOn) throw new Error(`extractor failed for ${document.id}`);
        return { documentId: document.id, reused: false, chunkCount: 1, versionHash: `hash-${document.id}` };
      },
      updateDocument: async () => {},
      yieldControl: onYield ?? (async () => {}),
      now: sequenceClock(2, 3, 4, 5, 6, 7, 8, 9),
    },
  };
};

test('creates normalized index jobs and validates their public inputs', () => {
  const job = createIndexJob({
    id: 'index-job-1', documentIds: ['doc-a', 'doc-a', 'doc-b'], force: true,
    idempotencyKey: 'request-0001', now: () => 10,
  });
  assert.deepEqual(job.documentIds, ['doc-a', 'doc-b']);
  assert.deepEqual(job.remainingDocumentIds, ['doc-a', 'doc-b']);
  assert.equal(job.createdAt, 10);
  assert.equal(job.force, true);
  assert.throws(() => createIndexJob({ documentIds: [] }), /between 1 and 10,000/);
  assert.throws(() => createIndexJob({ documentIds: [''] }), /non-empty strings/);
  assert.throws(() => createIndexJob({ documentIds: ['doc'], force: 'yes' }), /boolean/);
  assert.throws(() => createIndexJob({ documentIds: ['doc'], id: '' }), /id is required/);
  assert.throws(() => createIndexJob({ documentIds: ['doc'], idempotencyKey: 'short' }), /8 to 100/);
  assert.throws(() => createIndexJob({ documentIds: ['doc'], idempotencyKey: 42 }), /8 to 100/);
  assert.throws(() => createIndexJob({ documentIds: ['doc'], now: () => -1 }), /time/);
});

test('checkpoints each indexed document and completes idempotently', async () => {
  const job = createIndexJob({ id: 'index-job-2', documentIds: ['doc-a', 'doc-b'], now: () => 1 });
  const runner = memoryRunner(job);
  const completed = await runIndexJob(job, runner.dependencies);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.completedDocumentIds, ['doc-a', 'doc-b']);
  assert.deepEqual(completed.remainingDocumentIds, []);
  assert.deepEqual(runner.indexed, ['doc-a', 'doc-b']);
  assert.equal(completed.results[1].versionHash, 'hash-doc-b');
  assert.deepEqual(await runIndexJob(completed, runner.dependencies), completed);
});

test('preserves checkpoints after failure and resumes only unfinished documents', async () => {
  const job = createIndexJob({ id: 'index-job-3', documentIds: ['doc-a', 'doc-b', 'doc-c'], now: () => 1 });
  const failedRunner = memoryRunner(job, { failOn: 'doc-b' });
  await assert.rejects(runIndexJob(job, failedRunner.dependencies), /extractor failed/);
  const failed = failedRunner.current();
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.completedDocumentIds, ['doc-a']);
  assert.deepEqual(failed.remainingDocumentIds, ['doc-b', 'doc-c']);
  assert.match(failed.error, /doc-b/);

  const resumed = resumeIndexJob(failed, () => 20);
  const resumedRunner = memoryRunner(resumed);
  const completed = await runIndexJob(resumed, resumedRunner.dependencies);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(resumedRunner.indexed, ['doc-b', 'doc-c']);
  assert.deepEqual(completed.completedDocumentIds, ['doc-a', 'doc-b', 'doc-c']);
});

test('observes cancellation between documents and can resume it', async () => {
  const job = createIndexJob({ id: 'index-job-4', documentIds: ['doc-a', 'doc-b'], now: () => 1 });
  const runner = memoryRunner(job, {
    onYield: async () => {
      const cancelled = cancelIndexJob(runner.current(), () => 30);
      await runner.dependencies.save(cancelled);
    },
  });
  const cancelled = await runIndexJob(job, runner.dependencies);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.completedDocumentIds, ['doc-a']);
  assert.deepEqual(runner.indexed, ['doc-a']);
  assert.equal(cancelIndexJob(cancelled, () => 31), cancelled);
  assert.equal(resumeIndexJob(cancelled, () => 32).status, 'queued');
});

test('recovers interrupted jobs and rejects unsafe transitions', async () => {
  const queued = createIndexJob({ id: 'index-job-5', documentIds: ['doc-a'], now: () => 1 });
  assert.equal(recoverIndexJob(queued, () => 2), queued);
  const running = { ...queued, status: 'running' };
  const recovered = recoverIndexJob(running, sequenceClock(10, 11));
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.recoveredAt, 10);
  assert.throws(() => resumeIndexJob(running), /cannot be resumed/);
  assert.throws(() => cancelIndexJob({ ...queued, status: 'completed' }), /cannot be cancelled/);
  const failed = { ...queued, status: 'failed', error: 'bad' };
  const runner = memoryRunner(failed);
  await assert.rejects(runIndexJob(failed, runner.dependencies), /must be resumed/);
  await assert.rejects(runIndexJob(queued, {}), /require a load function/);
  await assert.rejects(runIndexJob(undefined, runner.dependencies), /valid index job/);
  await assert.rejects(runIndexJob({ ...queued, status: 'mystery' }, runner.dependencies), /Invalid index job status/);
  await assert.rejects(runIndexJob(queued, { ...runner.dependencies, now: 123 }), /time must be a function/);
  await assert.rejects(runIndexJob(queued, { ...runner.dependencies, yieldControl: true }), /yielding must be a function/);
});

test('records missing documents and invalid external state as durable failures', async () => {
  const job = createIndexJob({ id: 'index-job-6', documentIds: ['missing'], now: () => 1 });
  const runner = memoryRunner(job);
  runner.dependencies.getDocument = async () => undefined;
  await assert.rejects(runIndexJob(job, runner.dependencies), /Document not found/);
  assert.equal(runner.current().status, 'failed');

  const disappearing = memoryRunner(createIndexJob({ id: 'index-job-7', documentIds: ['doc'], now: () => 1 }));
  let calls = 0;
  disappearing.dependencies.load = async () => (++calls === 1 ? undefined : disappearing.current());
  await assert.rejects(runIndexJob(disappearing.current(), disappearing.dependencies), /disappeared/);
  assert.equal(disappearing.current().status, 'failed');
});
