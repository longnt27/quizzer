import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-storage-test-'));
process.env.QUIZZER_DATABASE_PATH = join(directory, 'quizzer.sqlite');
const {
  beginLegacyMigration, claimGenerationJob, completeGenerationJob, controlGenerationJob, finalizeLegacyMigration, getRecord, listLegacyMigrations,
  listRecords, putRecord, renewGenerationJobLease, subscribeStorageChanges, syncStorage, updateGenerationJobWithLease,
} = await import('../server/storage.mjs');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = changes => sha256(changes.map(change => ({
  key: `${change.collection}:${change.id}`,
  payloadHash: sha256(JSON.stringify(change)),
})).sort((left, right) => left.key.localeCompare(right.key)).map(item => `${item.key}:${item.payloadHash}\n`).join(''));

test.after(async () => rm(directory, { recursive: true, force: true }));

test('bootstraps, protects existing records, updates, and deletes', () => {
  const original = { id: 'test-1', name: 'Original', createdAt: 1, questions: [], attempts: [] };
  const first = syncStorage({
    cursor: 0,
    bootstrap: true,
    changes: [{ collection: 'tests', id: original.id, data: original }],
  });
  assert.equal(first.cursor, 1);
  assert.deepEqual(first.changes[0].data, original);

  const protectedBootstrap = syncStorage({
    cursor: 0,
    bootstrap: true,
    changes: [{ collection: 'tests', id: original.id, data: { ...original, name: 'Stale browser copy' } }],
  });
  assert.equal(protectedBootstrap.cursor, 1);
  assert.equal(protectedBootstrap.changes[0].data.name, 'Original');

  const updated = { ...original, name: 'Updated' };
  const update = syncStorage({
    cursor: 1,
    changes: [{ collection: 'tests', id: original.id, data: updated }],
  });
  assert.equal(update.cursor, 2);
  assert.equal(update.changes[0].data.name, 'Updated');

  const deletion = syncStorage({
    cursor: 2,
    changes: [{ collection: 'tests', id: original.id, deleted: true }],
  });
  assert.equal(deletion.cursor, 3);
  assert.equal(deletion.changes[0].deleted, true);
});

test('rejects unknown collections and malformed records', () => {
  assert.throws(() => syncStorage({
    changes: [{ collection: 'secrets', id: 'bad', data: {} }],
  }), /Invalid storage change/);
  assert.throws(() => syncStorage({
    changes: [{ collection: 'documents', id: 'bad', data: 'not an object' }],
  }), /must contain an object/);
});

test('synchronizes the versioned application profile', () => {
  const profile = {
    id: 'default',
    interfaceMode: 'simple',
    hardwareProfile: 'lite',
    onboarding: { onboardingVersion: 1, completedSteps: [], currentStep: 'welcome', skipped: false },
    createdAt: 10,
    updatedAt: 10,
    upgradedExistingLibrary: false,
  };
  const result = syncStorage({
    cursor: 3,
    changes: [{ collection: 'profiles', id: profile.id, data: profile }],
  });
  assert.equal(result.cursor, 4);
  assert.deepEqual(result.changes[0].data, profile);
});

test('synchronizes versioned prompt profiles', () => {
  const promptProfile = {
    id: 'team-grounded',
    name: 'Team grounded',
    version: 2,
    templates: { generation: 'generation', grading: 'grading', rag: 'rag' },
    createdAt: 30,
    updatedAt: 40,
  };
  const result = syncStorage({
    cursor: 4,
    changes: [{ collection: 'promptProfiles', id: promptProfile.id, data: promptProfile }],
  });
  assert.equal(result.cursor, 5);
  assert.deepEqual(getRecord('promptProfiles', promptProfile.id).data, promptProfile);
});

test('synchronizes durable index job checkpoints', () => {
  const indexJob = {
    id: 'index-sync-job', kind: 'index', status: 'running', documentIds: ['legacy-doc'],
    remainingDocumentIds: [], completedDocumentIds: ['legacy-doc'], results: [], force: false,
    createdAt: 50, updatedAt: 60,
  };
  const result = syncStorage({
    cursor: 5,
    changes: [{ collection: 'indexJobs', id: indexJob.id, data: indexJob }],
  });
  assert.equal(result.cursor, 6);
  assert.deepEqual(getRecord('indexJobs', indexJob.id).data, indexJob);
});

test('supports record-level reads, writes, and change subscriptions', () => {
  const events = [];
  const unsubscribe = subscribeStorageChanges(changes => events.push(...changes));
  const record = putRecord('generationJobs', 'job-1', { id: 'job-1', status: 'paused', updatedAt: 20 });
  unsubscribe();
  assert.equal(record.data.status, 'paused');
  assert.equal(getRecord('generationJobs', 'job-1').id, 'job-1');
  assert.equal(listRecords('generationJobs')[0].data.id, 'job-1');
  assert.equal(events.at(-1).collection, 'generationJobs');
  assert.throws(() => listRecords('secrets'), /Unknown storage collection/);
});

test('claims one generation worker at a time and recovers expired leases', () => {
  putRecord('generationJobs', 'lease-job', {
    id: 'lease-job', testId: 'lease-test', name: 'Lease test', status: 'queued',
    createdAt: 10, updatedAt: 10, documentIds: [], options: {}, questions: [], rejected: 0, rounds: {},
  });
  const claimed = claimGenerationJob({ workerId: 'worker-one', leaseMs: 10_000, now: 1_000 });
  assert.equal(claimed.data.workerId, 'worker-one');
  assert.equal(claimed.data.leaseExpiresAt, 11_000);
  assert.match(claimed.data.leaseId, /^[a-f0-9-]{36}$/);
  assert.equal(claimGenerationJob({ workerId: 'worker-two', leaseMs: 10_000, now: 2_000 }), undefined);
  const checkpointed = updateGenerationJobWithLease('lease-job', {
    workerId: 'worker-one', leaseId: claimed.data.leaseId, now: 3_000,
    patch: { questions: [{ statement: 'Saved question' }], rejected: 2, rounds: { reasoning: 1 } },
  });
  assert.equal(checkpointed.data.questions[0].statement, 'Saved question');
  assert.throws(() => renewGenerationJobLease('lease-job', {
    workerId: 'worker-two', leaseId: claimed.data.leaseId, leaseMs: 10_000, now: 2_000,
  }), /no longer owned/);
  const renewed = renewGenerationJobLease('lease-job', {
    workerId: 'worker-one', leaseId: claimed.data.leaseId, leaseMs: 10_000, now: 5_000,
  });
  assert.equal(renewed.data.leaseExpiresAt, 15_000);
  assert.throws(() => renewGenerationJobLease('lease-job', {
    workerId: 'worker-one', leaseId: claimed.data.leaseId, leaseMs: 10_000, now: 15_000,
  }), /expired/);
  const recovered = claimGenerationJob({ workerId: 'worker-two', leaseMs: 10_000, now: 15_001 });
  assert.equal(recovered.data.workerId, 'worker-two');
  assert.notEqual(recovered.data.leaseId, claimed.data.leaseId);
  assert.throws(() => updateGenerationJobWithLease('lease-job', {
    workerId: 'worker-one', leaseId: claimed.data.leaseId, now: 16_000, patch: { rejected: 99 },
  }), /no longer owned/);
  const completion = completeGenerationJob('lease-job', {
    workerId: 'worker-two', leaseId: recovered.data.leaseId, completionId: 'completion-one', now: 16_000,
    test: { id: 'lease-test', name: 'Lease test', createdAt: 16_000, questions: [{ statement: 'Saved question' }], attempts: [] },
    patch: { questions: [{ statement: 'Saved question' }], rejected: 2 },
  });
  assert.equal(completion.job.data.status, 'completed');
  assert.equal(completion.job.data.leaseId, undefined);
  assert.equal(completion.test.data.id, 'lease-test');
  const repeated = completeGenerationJob('lease-job', {
    workerId: 'worker-two', leaseId: recovered.data.leaseId, completionId: 'completion-one', now: 17_000,
    test: { id: 'lease-test', name: 'Lease test', createdAt: 16_000, questions: [{ statement: 'Saved question' }], attempts: [] },
  });
  assert.equal(repeated.job.revision, completion.job.revision);
});

test('enforces provider concurrency without blocking other queued routes', () => {
  const jobs = [
    ['provider-openai-one', 'openai', 30],
    ['provider-openai-two', 'openai', 31],
    ['provider-codex-one', 'codex', 32],
  ];
  for (const [id, provider, createdAt] of jobs) putRecord('generationJobs', id, {
    id, testId: `${id}-test`, name: id, status: 'queued', createdAt, updatedAt: createdAt,
    documentIds: [], options: { provider }, questions: [], rejected: 0, rounds: {},
  });
  const limits = { openai: 1, codex: 1 };
  const first = claimGenerationJob({ workerId: 'provider-worker-one', leaseMs: 10_000, now: 1_000, providerConcurrency: limits });
  assert.equal(first.id, 'provider-openai-one');
  const second = claimGenerationJob({ workerId: 'provider-worker-two', leaseMs: 10_000, now: 1_001, providerConcurrency: limits });
  assert.equal(second.id, 'provider-codex-one');
  assert.equal(claimGenerationJob({ workerId: 'provider-worker-three', leaseMs: 10_000, now: 1_002, providerConcurrency: limits }), undefined);
  assert.throws(() => claimGenerationJob({
    workerId: 'provider-worker-four', now: 1_003, providerConcurrency: { openai: 0 },
  }), /integers from 1 to 10/);
  for (const [id] of jobs) controlGenerationJob(id, 'cancel', {}, 1_100);
});

test('shares validated resume and cancel transitions across service clients', () => {
  putRecord('generationJobs', 'control-job', {
    id: 'control-job', testId: 'control-test', name: 'Controlled test', status: 'paused',
    createdAt: 20, updatedAt: 20, documentIds: [], options: { provider: 'gemini' },
    questions: [], rejected: 0, rounds: { reasoning: 2 }, error: 'Quota reached', errorCode: 'provider_limit',
  });
  const resumed = controlGenerationJob('control-job', 'resume', {
    options: { provider: 'codex' }, activeRouteIndex: 1, providerAttempts: [{ outcome: 'manually-selected' }], resetRounds: true,
  }, 21);
  assert.equal(resumed.data.status, 'queued');
  assert.equal(resumed.data.options.provider, 'codex');
  assert.deepEqual(resumed.data.rounds, {});
  assert.equal(resumed.data.error, undefined);
  const cancelled = controlGenerationJob('control-job', 'cancel', {}, 22);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.finishedAt, 22);
  assert.equal(controlGenerationJob('control-job', 'cancel', {}, 23).revision, cancelled.revision);
  assert.equal(controlGenerationJob('control-job', 'resume', {}, 24).data.status, 'queued');
  const running = claimGenerationJob({ workerId: 'control-worker', leaseMs: 10_000, now: 25 });
  assert.equal(running.id, 'control-job');
  assert.throws(() => controlGenerationJob('control-job', 'resume', {}, 26), /running.*cannot be resumed/);
  assert.throws(() => controlGenerationJob('control-job', 'resume', { resetRounds: 'yes' }, 26), /boolean/);
});

test('backs up, transactionally receipts, and verifies a legacy browser migration', async () => {
  const changes = [
    { collection: 'documents', id: 'legacy-doc', data: { id: 'legacy-doc', name: 'Legacy.md', content: 'Migrated content' } },
    { collection: 'tests', id: 'legacy-test', data: { id: 'legacy-test', name: 'Legacy quiz', questions: [], attempts: [] } },
  ];
  const migration = {
    id: 'migration-success-0001',
    expectedRecords: changes.length,
    expectedHash: fingerprint(changes),
  };
  const prepared = await beginLegacyMigration(migration);
  assert.equal(prepared.status, 'prepared');
  assert.ok((await stat(prepared.backupPath)).size > 0);
  assert.equal(sha256(await readFile(prepared.backupPath)), prepared.backupSha256);
  syncStorage({ cursor: 0, bootstrap: true, changes, migration });
  const completed = finalizeLegacyMigration(migration.id);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.receivedRecords, 2);
  assert.equal(completed.receivedHash, migration.expectedHash);
  assert.equal(getRecord('documents', 'legacy-doc').data.name, 'Legacy.md');
  assert.equal(listLegacyMigrations()[0].backupPath, prepared.backupPath);
});

test('keeps the rollback backup when migration verification fails', async () => {
  const changes = [{ collection: 'tests', id: 'legacy-bad', data: { id: 'legacy-bad', name: 'Mismatch', questions: [], attempts: [] } }];
  const migration = { id: 'migration-failure-0001', expectedRecords: 1, expectedHash: '0'.repeat(64) };
  const prepared = await beginLegacyMigration(migration);
  syncStorage({ cursor: 0, bootstrap: true, changes, migration });
  assert.throws(() => finalizeLegacyMigration(migration.id), /verification failed.*Rollback backup/);
  assert.ok((await stat(prepared.backupPath)).size > 0);
  assert.equal(listLegacyMigrations().find(item => item.id === migration.id).status, 'failed');
});
