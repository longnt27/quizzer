import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveSettings } from '../server/settings.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-storage-test-'));
process.env.QUIZZER_DATABASE_PATH = join(directory, 'quizzer.sqlite');
const {
  beginLegacyMigration, claimGenerationJob, completeGenerationJob, controlGenerationJob, createGenerationJobs, finalizeLegacyMigration, getRecord, listLegacyMigrations,
  listRecords, putRecord, renewGenerationJobLease, subscribeStorageChanges, syncStorage, updateGenerationJobWithLease,
  reserveGenerationAttempt, finalizeGenerationAttempt, getGenerationAccounting, raiseGenerationCostCeiling,
} = await import('../server/storage.mjs');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = changes => sha256(changes.map(change => ({
  key: `${change.collection}:${change.id}`,
  payloadHash: sha256(JSON.stringify(change)),
})).sort((left, right) => left.key.localeCompare(right.key)).map(item => `${item.key}:${item.payloadHash}\n`).join(''));
const resolvedSettings = resolveSettings({ environment: {} }).values;
const generationOptions = (provider = 'codex') => ({
  provider,
  questionCount: 1,
  ragProfile: { id: 'lite', retrieval: 'sparse', contextBudget: 4_096, rerank: false },
  routeChain: [{
    provider,
    privacy: provider.endsWith('-agent') || provider === 'codex' ? 'signed-in-agent' : 'remote-api',
    paid: !(provider.endsWith('-agent') || provider === 'codex'),
    approved: true,
  }],
  resolvedSettings,
});

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
  assert.throws(() => syncStorage({
    cursor: 4,
    changes: [{ collection: 'profiles', id: profile.id, data: {
      ...profile, onboarding: { ...profile.onboarding, currentStep: 'unknown' },
    } }],
  }), /Current onboarding step/);
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

test('creates validated generation jobs transactionally and keeps generic sync read-only', () => {
  putRecord('documents', 'creation-doc', { id: 'creation-doc', name: 'Creation.md', content: 'Evidence' });
  const job = {
    id: 'created-generation-job', testId: 'created-generation-test', name: 'Created through service',
    createdAt: 25, updatedAt: 25, status: 'queued', documentIds: ['creation-doc'],
    options: generationOptions('openai'), questions: [], rejected: 0, rounds: {},
  };
  const [created] = createGenerationJobs([job]);
  assert.equal(created.data.status, 'queued');
  assert.match(created.data.creationFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(createGenerationJobs([job])[0].revision, created.revision);
  const progressed = putRecord('generationJobs', job.id, { ...created.data, options: generationOptions('codex') });
  assert.equal(createGenerationJobs([job])[0].revision, progressed.revision);
  assert.throws(() => createGenerationJobs([{ ...job, name: 'Conflicting retry' }]), /job id is already used/);
  assert.throws(() => controlGenerationJob(job.id, 'resume', {
    options: { provider: 'openai', questionCount: 1 }, activeRouteIndex: 0,
  }, 26), /require a RAG profile snapshot/);
  assert.throws(() => createGenerationJobs([{ ...job, id: 'missing-document-job', testId: 'missing-document-test', documentIds: ['absent'] }]), /documents not found/);
  const transactionJob = { ...job, id: 'transaction-job', testId: 'transaction-test' };
  assert.throws(() => createGenerationJobs([
    transactionJob,
    { ...job, id: 'transaction-missing-job', testId: 'transaction-missing-test', documentIds: ['absent'] },
  ]), /documents not found/);
  assert.equal(getRecord('generationJobs', transactionJob.id), undefined);
  assert.throws(() => syncStorage({
    changes: [{ collection: 'generationJobs', id: 'forged-job', data: job }],
  }), /must be created and updated through/);
  assert.throws(() => syncStorage({
    changes: [{ collection: 'generationJobs', id: job.id, deleted: true }],
  }), /Active generation jobs cannot be deleted/);
  controlGenerationJob(job.id, 'cancel', {}, 27);
  syncStorage({ changes: [{ collection: 'generationJobs', id: job.id, deleted: true }] });
  assert.equal(getRecord('generationJobs', job.id), undefined);
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
    options: generationOptions('codex'), activeRouteIndex: 0,
    providerAttempts: [{ provider: 'codex', routeIndex: 0, at: 21, accepted: 0, outcome: 'manually-selected' }],
    resetRounds: true,
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

test('allows route continuation without rewriting a modern generation contract or audit history', () => {
  const originalOptions = generationOptions('openai');
  const codexRoute = { provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true };
  putRecord('generationJobs', 'route-policy-job', {
    id: 'route-policy-job', testId: 'route-policy-test', name: 'Route policy', status: 'paused',
    createdAt: 70, updatedAt: 70, documentIds: ['creation-doc'], options: originalOptions,
    questions: [], rejected: 0, rounds: {}, creationFingerprint: 'a'.repeat(64),
  });
  const continuedOptions = {
    ...originalOptions, provider: 'codex', routeChain: [...originalOptions.routeChain, codexRoute],
  };
  const continued = controlGenerationJob('route-policy-job', 'resume', {
    options: continuedOptions,
    activeRouteIndex: 1,
    providerAttempts: [{ provider: 'codex', routeIndex: 1, at: 71, accepted: 0, outcome: 'manually-selected' }],
  }, 71);
  assert.equal(continued.data.options.provider, 'codex');
  assert.equal(continued.data.options.questionCount, 1);
  assert.equal(continued.data.providerAttempts.length, 1);
  assert.throws(() => controlGenerationJob('route-policy-job', 'resume', {
    options: { ...continuedOptions, customInstruction: 'Change the job after it was queued.' }, activeRouteIndex: 1,
  }, 72), /customInstruction cannot change/);
  assert.throws(() => controlGenerationJob('route-policy-job', 'resume', {
    options: { ...continuedOptions, routeChain: [...continuedOptions.routeChain].reverse() }, activeRouteIndex: 0,
  }, 72), /removed, reordered, or changed/);
  assert.throws(() => controlGenerationJob('route-policy-job', 'resume', {
    providerAttempts: [],
  }, 72), /attempt history is append-only/);
  controlGenerationJob('route-policy-job', 'cancel', {}, 73);
});

test('lets workers select only an existing pre-approved route', () => {
  const originalOptions = generationOptions('openai');
  const routeChain = [
    ...originalOptions.routeChain,
    { provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true },
  ];
  const leaseId = 'route-worker-lease';
  putRecord('generationJobs', 'route-worker-job', {
    id: 'route-worker-job', testId: 'route-worker-test', name: 'Automatic route', status: 'running',
    createdAt: 80, updatedAt: 80, documentIds: ['creation-doc'], workerId: 'route-worker', leaseId, leaseExpiresAt: 10_000,
    options: { ...originalOptions, routeChain }, questions: [], rejected: 0, rounds: {}, creationFingerprint: 'b'.repeat(64),
  });
  const automaticOptions = { ...originalOptions, provider: 'codex', routeChain };
  const switched = updateGenerationJobWithLease('route-worker-job', {
    workerId: 'route-worker', leaseId, now: 81,
    patch: {
      options: automaticOptions,
      activeRouteIndex: 1,
      providerAttempts: [{
        provider: 'openai', routeIndex: 0, at: 81, accepted: 0, outcome: 'failed', errorCode: 'provider_limit',
      }],
    },
  });
  assert.equal(switched.data.options.provider, 'codex');
  assert.throws(() => updateGenerationJobWithLease('route-worker-job', {
    workerId: 'route-worker', leaseId, now: 82,
    patch: { options: { ...automaticOptions, routeChain: [...routeChain, {
      provider: 'claude-agent', privacy: 'signed-in-agent', paid: false, approved: true,
    }] } },
  }), /workers cannot change the approved route chain/);
  assert.throws(() => updateGenerationJobWithLease('route-worker-job', {
    workerId: 'route-worker', leaseId, now: 82,
    patch: { options: { ...automaticOptions, questionCount: 2 } },
  }), /questionCount cannot change/);
  assert.throws(() => updateGenerationJobWithLease('route-worker-job', {
    workerId: 'route-worker', leaseId, now: 82,
    patch: { providerAttempts: [] },
  }), /attempt history is append-only/);
  controlGenerationJob('route-worker-job', 'cancel', {}, 83);
});

test('rejects malformed modern question checkpoints before committing them', () => {
  const leaseId = 'strict-checkpoint-lease';
  putRecord('generationJobs', 'strict-checkpoint-job', {
    id: 'strict-checkpoint-job', testId: 'strict-checkpoint-test', name: 'Strict checkpoint', status: 'running',
    createdAt: 100, updatedAt: 100, documentIds: ['strict-doc'], workerId: 'strict-worker', leaseId, leaseExpiresAt: 10_000,
    options: { provider: 'codex', questionCount: 1, ragProfile: { id: 'balanced' } }, questions: [], rejected: 0, rounds: {},
  });
  assert.throws(() => updateGenerationJobWithLease('strict-checkpoint-job', {
    workerId: 'strict-worker', leaseId, now: 101,
    patch: { questions: [{ statement: 'This lacks its enforced answer schema and provenance.' }] },
  }), /Multiple-choice questions require 3-6 answers/);
  assert.throws(() => updateGenerationJobWithLease('strict-checkpoint-job', {
    workerId: 'strict-worker', leaseId, now: 101, patch: { rejected: -1 },
  }), /non-negative integer/);
  assert.throws(() => updateGenerationJobWithLease('strict-checkpoint-job', {
    workerId: 'strict-worker', leaseId, now: 101, patch: { rounds: { reasoning: 6 } },
  }), /rounds are invalid/);
  controlGenerationJob('strict-checkpoint-job', 'cancel', {}, 102);
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

test('durably accounts reservations, unknown usage, replay mismatches, over-ceiling spend, and explicit raises', () => {
  const priced = { ...generationOptions(), costCeilingMicroUsd: 3 };
  priced.routeChain = [{ ...priced.routeChain[0], pricing: { inputMicroUsdPerMillionTokens: 1_500_000, outputMicroUsdPerMillionTokens: 2_000_000 } }];
  putRecord('documents', 'accounting-doc', { id: 'accounting-doc' });
  const job = { id: 'accounting-job', testId: 'accounting-test', name: 'Accounting', createdAt: 10, updatedAt: 10, status: 'queued', documentIds: ['accounting-doc'], options: priced, questions: [], rejected: 0, rounds: {} };
  createGenerationJobs([job]);
  const claimed = claimGenerationJob({ workerId: 'accounting-worker', now: 100, leaseMs: 10_000, providerConcurrency: { codex: 10 } });
  reserveGenerationAttempt(job.id, { workerId: 'accounting-worker', leaseId: claimed.data.leaseId, attemptId: 'accounting-attempt', routeIndex: 0, maxInputTokens: 1, maxOutputTokens: 0, now: 101 });
  reserveGenerationAttempt(job.id, { workerId: 'accounting-worker', leaseId: claimed.data.leaseId, attemptId: 'accounting-attempt', routeIndex: 0, maxInputTokens: 1, maxOutputTokens: 0, now: 102 });
  assert.throws(() => reserveGenerationAttempt(job.id, { workerId: 'accounting-worker', leaseId: claimed.data.leaseId, attemptId: 'accounting-attempt', routeIndex: 0, maxInputTokens: 2, maxOutputTokens: 0, now: 102 }), /replay parameters/);
  finalizeGenerationAttempt(job.id, { workerId: 'accounting-worker', leaseId: claimed.data.leaseId, attemptId: 'accounting-attempt', usage: { unknown: true, reason: 'missing' }, now: 103 });
  assert.equal(getGenerationAccounting(job.id).summary.reservedCostMicroUsd, 2);
  finalizeGenerationAttempt(job.id, { workerId: 'accounting-worker', leaseId: claimed.data.leaseId, attemptId: 'accounting-attempt', usage: { unknown: true, reason: 'missing' }, now: 104 });
  assert.throws(() => finalizeGenerationAttempt(job.id, { workerId: 'accounting-worker', leaseId: claimed.data.leaseId, attemptId: 'accounting-attempt', usage: { inputTokens: 1, outputTokens: 0 }, now: 104 }), /replay parameters/);
  updateGenerationJobWithLease(job.id, { workerId: 'accounting-worker', leaseId: claimed.data.leaseId, patch: { status: 'paused' }, now: 105 });
  raiseGenerationCostCeiling(job.id, { newCeilingMicroUsd: 10, reason: 'approved extension', confirmed: true, now: 106 });
  assert.equal(getRecord('generationJobs', job.id).data.options.costCeilingMicroUsd, 10);
});
