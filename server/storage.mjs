import Database from 'better-sqlite3';
import { validateQuestionCheckpoint } from './question-validation.mjs';
import {
  isModernGenerationOptions, validateActiveRoute, validateCoveragePlan, validateGenerationOptions,
  validateGenerationOptionsTransition, validateGenerationProgress, validateGenerationRejectionTransition, validateNewGenerationJob,
  validateProviderAttemptTransition, validateGenerationAccounting,
} from './generation-validation.mjs';
import {
  addUsageSummary, assertCostWithinCeiling, emptyUsageSummary, estimateRouteCost,
  normalizeProviderUsage, normalizeReservationUsage, normalizeUsageSummary, routePricing, validateCostCeiling,
  validateMicroUsd, validateUsageInteger,
} from './generation-cost.mjs';
import { validateOnboardingState } from './onboarding.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const collections = new Set(['tests', 'documents', 'generationJobs', 'indexJobs', 'testDrafts', 'profiles', 'promptProfiles']);
const databasePath = process.env.QUIZZER_DATABASE_PATH
  || join(process.env.QUIZZER_APP_DATA_DIR || process.cwd(), '.quizzer-data', 'quizzer.sqlite');

mkdirSync(dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
const hashFile = path => new Promise((resolve, reject) => {
  const digest = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', chunk => digest.update(chunk));
  input.once('error', reject);
  input.once('end', () => resolve(digest.digest('hex')));
});
const schemaVersion = Number(database.pragma('user_version', { simple: true }));
if (schemaVersion > 2) throw new Error(`Quizzer database schema ${schemaVersion} is newer than this server supports`);
let schemaBackupPath;
if (schemaVersion === 1) {
  const backupDirectory = join(process.env.QUIZZER_APP_DATA_DIR || dirname(databasePath), 'backups', 'schema');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  schemaBackupPath = join(backupDirectory, `before-schema-v2-${stamp}.sqlite`);
  await database.backup(schemaBackupPath);
  await chmod(schemaBackupPath, 0o600).catch(error => { if (process.platform !== 'win32') throw error; });
  const backupSha256 = await hashFile(schemaBackupPath);
  await writeFile(`${schemaBackupPath}.sha256`, `${backupSha256}  ${schemaBackupPath.split(/[\\/]/).at(-1)}\n`, { mode: 0o600, flag: 'wx' });
  database.exec(`
    DROP TRIGGER IF EXISTS rag_chunks_ai;
    DROP TRIGGER IF EXISTS rag_chunks_ad;
    DROP TRIGGER IF EXISTS rag_chunks_au;
    DROP TABLE IF EXISTS rag_chunks_fts;
    DROP TABLE IF EXISTS rag_chunks;
  `);
}
database.exec(`
  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE TABLE IF NOT EXISTS changes (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    data TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS changes_revision_idx ON changes(revision);
  CREATE TABLE IF NOT EXISTS legacy_migrations (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    expected_records INTEGER NOT NULL,
    expected_hash TEXT NOT NULL,
    received_records INTEGER NOT NULL DEFAULT 0,
    received_hash TEXT,
    backup_path TEXT NOT NULL,
    backup_sha256 TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS legacy_migration_items (
    migration_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    PRIMARY KEY (migration_id, collection, record_id),
    FOREIGN KEY (migration_id) REFERENCES legacy_migrations(id) ON DELETE CASCADE
  );
`);
database.pragma('user_version = 2');

const insertChange = database.prepare(`
  INSERT INTO changes (collection, record_id, data, deleted, updated_at)
  VALUES (@collection, @id, @data, @deleted, @updatedAt)
`);
const upsertRecord = database.prepare(`
  INSERT INTO records (collection, id, data, deleted, revision, updated_at)
  VALUES (@collection, @id, @data, @deleted, @revision, @updatedAt)
  ON CONFLICT(collection, id) DO UPDATE SET
    data = excluded.data,
    deleted = excluded.deleted,
    revision = excluded.revision,
    updated_at = excluded.updated_at
`);
const recordExists = database.prepare('SELECT 1 FROM records WHERE collection = ? AND id = ?');
const changesAfter = database.prepare(`
  SELECT revision, collection, record_id AS id, data, deleted, updated_at AS updatedAt
  FROM changes WHERE revision > ? ORDER BY revision ASC
`);
const currentRevision = database.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM changes');
const recordsInCollection = database.prepare(`
  SELECT id, data, revision, updated_at AS updatedAt
  FROM records WHERE collection = ? AND deleted = 0 ORDER BY updated_at DESC
`);
const recordById = database.prepare(`
  SELECT id, data, revision, updated_at AS updatedAt
  FROM records WHERE collection = ? AND id = ? AND deleted = 0
`);
const migrationById = database.prepare(`
  SELECT id, status, expected_records AS expectedRecords, expected_hash AS expectedHash,
    received_records AS receivedRecords, received_hash AS receivedHash,
    backup_path AS backupPath, backup_sha256 AS backupSha256,
    started_at AS startedAt, completed_at AS completedAt, error
  FROM legacy_migrations WHERE id = ?
`);
const insertMigration = database.prepare(`
  INSERT INTO legacy_migrations (
    id, status, expected_records, expected_hash, backup_path, backup_sha256, started_at
  ) VALUES (@id, 'prepared', @expectedRecords, @expectedHash, @backupPath, @backupSha256, @startedAt)
`);
const insertMigrationItem = database.prepare(`
  INSERT INTO legacy_migration_items (migration_id, collection, record_id, payload_hash)
  VALUES (@migrationId, @collection, @id, @payloadHash)
  ON CONFLICT(migration_id, collection, record_id) DO UPDATE SET payload_hash = excluded.payload_hash
`);
const migrationItems = database.prepare(`
  SELECT collection, record_id AS id, payload_hash AS payloadHash
  FROM legacy_migration_items WHERE migration_id = ? ORDER BY collection, record_id
`);
const missingMigrationRecords = database.prepare(`
  SELECT COUNT(*) AS missing FROM legacy_migration_items item
  LEFT JOIN records record ON record.collection = item.collection AND record.id = item.record_id
  WHERE item.migration_id = ? AND (record.id IS NULL OR record.deleted <> 0)
`);
const finishMigration = database.prepare(`
  UPDATE legacy_migrations SET status = @status, received_records = @receivedRecords,
    received_hash = @receivedHash, completed_at = @completedAt, error = @error WHERE id = @id
`);
const allMigrations = database.prepare(`
  SELECT id, status, expected_records AS expectedRecords, expected_hash AS expectedHash,
    received_records AS receivedRecords, received_hash AS receivedHash,
    backup_path AS backupPath, backup_sha256 AS backupSha256,
    started_at AS startedAt, completed_at AS completedAt, error
  FROM legacy_migrations ORDER BY started_at DESC
`);
const listeners = new Set();

const sha256 = value => createHash('sha256').update(value).digest('hex');
const migrationDigest = items => sha256(items.map(item => `${item.collection}:${item.id}:${item.payloadHash}\n`).join(''));

const validateMigration = migration => {
  if (!migration || typeof migration.id !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(migration.id)) throw new Error('Invalid legacy migration id');
  if (!Number.isSafeInteger(migration.expectedRecords) || migration.expectedRecords < 0 || migration.expectedRecords > 1_000_000) throw new Error('Invalid legacy migration record count');
  if (!/^[a-f0-9]{64}$/.test(migration.expectedHash ?? '')) throw new Error('Invalid legacy migration hash');
  return migration;
};

const validateChange = (change, { bootstrap = false, trusted = false } = {}) => {
  if (!change || !collections.has(change.collection) || typeof change.id !== 'string' || !change.id) {
    throw new Error('Invalid storage change');
  }
  if (!change.deleted && (typeof change.data !== 'object' || change.data === null)) {
    throw new Error('Storage records must contain an object');
  }
  if (!change.deleted && change.collection === 'profiles') {
    if (change.id !== 'default' || change.data.id !== 'default') throw new Error('Application profile id must be default');
    validateOnboardingState(change.data.onboarding);
  }
  if (!bootstrap && !trusted && change.collection === 'generationJobs') {
    if (!change.deleted) throw new Error('Generation jobs must be created and updated through /api/v1/jobs');
    const existing = recordById.get('generationJobs', change.id);
    const status = existing ? JSON.parse(existing.data).status : undefined;
    if (existing && !['completed', 'cancelled'].includes(status)) throw new Error('Active generation jobs cannot be deleted through storage sync');
  }
  if (!trusted && !change.deleted && change.collection === 'generationJobs'
    && (change.data.usageSummary !== undefined || change.data.usageAudit !== undefined)) {
    throw new Error('Generation accounting is service-owned and cannot be supplied through storage sync');
  }
};

const applyChanges = database.transaction((changes, bootstrap, migrationId, migrationPayloadHashes, trusted) => {
  const now = Date.now();
  const applied = [];
  for (const change of changes) {
    validateChange(change, { bootstrap, trusted });
    if (migrationId) insertMigrationItem.run({
      migrationId,
      collection: change.collection,
      id: change.id,
      payloadHash: migrationPayloadHashes?.get(`${change.collection}:${change.id}`) ?? sha256(JSON.stringify(change)),
    });
    if (bootstrap && recordExists.get(change.collection, change.id)) continue;
    const stored = {
      collection: change.collection,
      id: change.id,
      data: change.deleted ? null : JSON.stringify(change.data),
      deleted: change.deleted ? 1 : 0,
      updatedAt: now,
    };
    const result = insertChange.run(stored);
    const revision = Number(result.lastInsertRowid);
    upsertRecord.run({ ...stored, revision });
    applied.push({ revision, collection: change.collection, id: change.id, deleted: Boolean(change.deleted), updatedAt: now });
  }
  return applied;
});

export const syncStorage = ({ cursor = 0, changes = [], bootstrap = false, migration } = {}, { migrationPayloadHashes, trusted = false } = {}) => {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Array.isArray(changes) || changes.length > 10_000) {
    throw new Error('Invalid storage sync request');
  }
  if (migration && !bootstrap) throw new Error('Legacy migration metadata requires bootstrap mode');
  if (migration) validateMigration(migration);
  const applied = applyChanges(changes, Boolean(bootstrap), migration?.id, migrationPayloadHashes, Boolean(trusted));
  if (applied.length) for (const listener of listeners) listener(applied);
  const rows = changesAfter.all(cursor);
  return {
    cursor: Number(currentRevision.get().revision),
    changes: rows.map(row => ({
      ...row,
      deleted: Boolean(row.deleted),
      data: row.data === null ? undefined : JSON.parse(row.data),
    })),
  };
};

export const beginLegacyMigration = async migrationInput => {
  const migration = validateMigration(migrationInput);
  const existing = migrationById.get(migration.id);
  if (existing) {
    if (existing.expectedRecords !== migration.expectedRecords || existing.expectedHash !== migration.expectedHash) {
      throw new Error('Legacy migration contents changed; restart it with a new migration id');
    }
    return existing;
  }
  const backupDirectory = join(process.env.QUIZZER_APP_DATA_DIR || dirname(databasePath), 'backups', 'migrations');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDirectory, `before-indexeddb-${stamp}-${migration.id.slice(0, 12)}.sqlite`);
  await database.backup(backupPath);
  const backupSha256 = await hashFile(backupPath);
  insertMigration.run({ ...migration, backupPath, backupSha256, startedAt: Date.now() });
  return migrationById.get(migration.id);
};

export const finalizeLegacyMigration = migrationId => {
  const migration = migrationById.get(migrationId);
  if (!migration) throw new Error('Legacy migration was not prepared');
  if (migration.status === 'complete') return migration;
  const items = migrationItems.all(migrationId);
  const receivedHash = migrationDigest(items);
  const missing = Number(missingMigrationRecords.get(migrationId).missing);
  const errors = [];
  if (items.length !== migration.expectedRecords) errors.push(`expected ${migration.expectedRecords} records but received ${items.length}`);
  if (receivedHash !== migration.expectedHash) errors.push('the received record hash did not match');
  if (missing) errors.push(`${missing} migrated records are missing from SQLite`);
  const completedAt = Date.now();
  finishMigration.run({
    id: migrationId,
    status: errors.length ? 'failed' : 'complete',
    receivedRecords: items.length,
    receivedHash,
    completedAt,
    error: errors.join('; ') || null,
  });
  const result = migrationById.get(migrationId);
  if (errors.length) throw new Error(`Legacy migration verification failed: ${errors.join('; ')}. Rollback backup: ${migration.backupPath}`);
  return result;
};

export const listLegacyMigrations = () => allMigrations.all();

const validateCollection = collection => {
  if (!collections.has(collection)) throw new Error(`Unknown storage collection: ${collection}`);
};

const decodeRecord = row => row ? { ...row, data: JSON.parse(row.data) } : undefined;

export const listRecords = collection => {
  validateCollection(collection);
  return recordsInCollection.all(collection).map(decodeRecord);
};

export const getRecord = (collection, id) => {
  validateCollection(collection);
  if (typeof id !== 'string' || !id) throw new Error('A record id is required');
  return decodeRecord(recordById.get(collection, id));
};

export const putRecord = (collection, id, data) => {
  validateChange({ collection, id, data }, { trusted: true });
  syncStorage({ cursor: Number(currentRevision.get().revision), changes: [{ collection, id, data }] }, { trusted: true });
  return getRecord(collection, id);
};

export const deleteRecord = (collection, id) => {
  validateCollection(collection);
  syncStorage({ cursor: Number(currentRevision.get().revision), changes: [{ collection, id, deleted: true }] }, { trusted: true });
};

const generationRequestFingerprint = job => sha256(JSON.stringify({
  id: job.id,
  testId: job.testId,
  name: job.name,
  createdAt: job.createdAt,
  documentIds: job.documentIds,
  options: job.options,
}));

export const createGenerationJobs = jobs => {
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 100) throw new Error('Generation job creation requires 1-100 jobs');
  jobs.forEach(validateNewGenerationJob);
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('Generation job ids must be unique');
  if (new Set(jobs.map(job => job.testId)).size !== jobs.length) throw new Error('Generation test ids must be unique');

  const knownTestIds = new Set(listRecords('tests').map(record => record.id));
  const generationRecords = listRecords('generationJobs');
  const jobById = new Map(generationRecords.map(record => [record.id, record]));
  const jobByTestId = new Map(generationRecords.map(record => [record.data.testId, record]));
  const changes = [];
  for (const job of jobs) {
    const missingDocuments = job.documentIds.filter(id => !getRecord('documents', id));
    if (missingDocuments.length) throw new Error(`Generation documents not found: ${missingDocuments.join(', ')}`);
    const existing = jobById.get(job.id);
    if (existing) {
      if (existing.data.creationFingerprint !== generationRequestFingerprint(job)) throw new Error(`Generation job id is already used: ${job.id}`);
      continue;
    }
    if (knownTestIds.has(job.testId) || jobByTestId.has(job.testId)) throw new Error(`Generation test id is already used: ${job.testId}`);
    changes.push({
      collection: 'generationJobs', id: job.id,
      data: { ...job, creationFingerprint: generationRequestFingerprint(job) },
    });
  }
  if (changes.length) syncStorage({
    cursor: Number(currentRevision.get().revision), changes,
  }, { trusted: true });
  return jobs.map(job => getRecord('generationJobs', job.id));
};

const validateWorker = (workerId, leaseMs) => {
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(workerId)) throw new Error('Invalid generation worker id');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 120_000) throw new Error('Generation lease must be between 10 and 120 seconds');
};

const validateLeaseTime = now => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid generation lease time');
};

const requireActiveGenerationLease = (existing, { workerId, leaseId, now }) => {
  if (!existing) throw new Error('Generation job not found');
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(workerId)) throw new Error('Invalid generation worker id');
  if (typeof leaseId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(leaseId)) throw new Error('Invalid generation lease id');
  validateLeaseTime(now);
  if (existing.data.status !== 'running' || existing.data.workerId !== workerId || existing.data.leaseId !== leaseId) {
    throw new Error('Generation lease is no longer owned by this worker');
  }
  if (!Number.isSafeInteger(existing.data.leaseExpiresAt) || existing.data.leaseExpiresAt <= now) {
    throw new Error('Generation lease has expired');
  }
};

const claimGenerationJobTransaction = database.transaction((workerId, leaseMs, now, providerConcurrency, defaultProviderConcurrency) => {
  const records = recordsInCollection.all('generationJobs').map(decodeRecord);
  const activeByProvider = new Map();
  for (const record of records) {
    const job = record.data;
    if (job.status !== 'running' || !Number.isFinite(job.leaseExpiresAt) || job.leaseExpiresAt <= now) continue;
    const provider = typeof job.options?.provider === 'string' ? job.options.provider : 'unknown';
    activeByProvider.set(provider, (activeByProvider.get(provider) ?? 0) + 1);
  }
  const candidates = records.filter(record => {
    const job = record.data;
    return job.status === 'queued'
      || (job.status === 'waiting' && (job.nextAttemptAt ?? 0) <= now)
      || (job.status === 'running' && (!Number.isFinite(job.leaseExpiresAt) || job.leaseExpiresAt <= now));
  }).sort((left, right) => (left.data.createdAt ?? 0) - (right.data.createdAt ?? 0));
  const selected = candidates.find(record => {
    const provider = typeof record.data.options?.provider === 'string' ? record.data.options.provider : 'unknown';
    const limit = Object.hasOwn(providerConcurrency, provider) ? providerConcurrency[provider] : defaultProviderConcurrency;
    return (activeByProvider.get(provider) ?? 0) < limit;
  });
  if (!selected) return undefined;
  const data = {
    ...selected.data,
    status: 'running',
    workerId,
    leaseId: randomUUID(),
    leaseExpiresAt: now + leaseMs,
    error: undefined,
    errorCode: undefined,
    nextAttemptAt: undefined,
    updatedAt: now,
  };
  return putRecord('generationJobs', selected.id, data);
});

export const claimGenerationJob = ({
  workerId, leaseMs = 45_000, now = Date.now(), providerConcurrency = {}, defaultProviderConcurrency = 1,
} = {}) => {
  validateWorker(workerId, leaseMs);
  validateLeaseTime(now);
  if (!providerConcurrency || typeof providerConcurrency !== 'object' || Array.isArray(providerConcurrency)) {
    throw new Error('Provider concurrency limits must be an object');
  }
  if (!Number.isSafeInteger(defaultProviderConcurrency) || defaultProviderConcurrency < 1 || defaultProviderConcurrency > 10) {
    throw new Error('Default provider concurrency must be an integer from 1 to 10');
  }
  for (const [provider, limit] of Object.entries(providerConcurrency)) {
    if (!provider || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error('Provider concurrency limits must be integers from 1 to 10');
    }
  }
  return claimGenerationJobTransaction(workerId, leaseMs, now, providerConcurrency, defaultProviderConcurrency);
};

export const renewGenerationJobLease = (id, { workerId, leaseId, leaseMs = 45_000, now = Date.now() } = {}) => {
  validateWorker(workerId, leaseMs);
  const existing = getRecord('generationJobs', id);
  requireActiveGenerationLease(existing, { workerId, leaseId, now });
  return putRecord('generationJobs', id, { ...existing.data, leaseExpiresAt: now + leaseMs, updatedAt: now });
};

const accountingId = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(value)) throw new Error(`Invalid generation ${label}`);
  return value;
};
const accountingState = job => {
  const summary = normalizeUsageSummary(job.usageSummary ?? emptyUsageSummary);
  const audit = job.usageAudit ?? [];
  validateGenerationAccounting(summary, audit, job.options);
  return { summary, audit };
};
const accountingRoute = (job, routeIndex) => {
  const options = job.options;
  const route = options?.routeChain?.[routeIndex];
  if (!route) throw new Error('Generation accounting route is not available');
  if (route.provider !== options.provider || (route.model ?? undefined) !== (options.model ?? undefined)) {
    // Failover routes are valid, but the route must still be part of the
    // immutable route-chain snapshot.
    if (!options.routeChain.includes(route)) throw new Error('Generation accounting route is invalid');
  }
  return route;
};
const accountingCeiling = job => validateCostCeiling(job.options?.costCeilingMicroUsd ?? job.costCeilingMicroUsd);
const findAccountingEvent = (audit, attemptId, event) => audit.find(item => item.attemptId === attemptId && item.event === event);

/* Atomically append a reservation before a provider request is sent. */
export const reserveGenerationAttempt = (id, {
  workerId, leaseId, attemptId, routeIndex, maxInputTokens, maxOutputTokens,
  estimatedUsage, now = Date.now(),
} = {}) => {
  accountingId(attemptId, 'accounting attempt id');
  if (!Number.isSafeInteger(routeIndex) || routeIndex < 0 || routeIndex > 999) throw new Error('Invalid generation accounting route index');
  const bounds = estimatedUsage !== undefined
    ? normalizeReservationUsage(estimatedUsage)
    : normalizeReservationUsage({ inputTokens: maxInputTokens, outputTokens: maxOutputTokens });
  const existing = getRecord('generationJobs', id);
  requireActiveGenerationLease(existing, { workerId, leaseId, now });
  const { summary, audit } = accountingState(existing.data);
  const route = accountingRoute(existing.data, routeIndex);
  const pricing = routePricing(route);
  const reservationCost = pricing ? estimateRouteCost(route, bounds) : undefined;
  const reservationCostKnown = reservationCost !== undefined;
  const ceiling = accountingCeiling(existing.data);
  if (ceiling !== undefined && !reservationCostKnown) throw new Error('Cannot reserve an attempt with unknown provider pricing under a finite cost ceiling');
  const fingerprint = sha256(JSON.stringify({ routeIndex, bounds, reservationCostMicroUsd: reservationCost ?? 0, reservationCostKnown }));
  const prior = audit.find(item => item.attemptId === attemptId);
  if (prior) {
    const sameReservation = prior.event === 'reserved' && prior.reservationFingerprint === fingerprint
      && prior.routeIndex === routeIndex && prior.reservationInputTokens === bounds.inputTokens
      && prior.reservationOutputTokens === bounds.outputTokens;
    if (sameReservation) return existing;
    throw new Error('Generation accounting attempt replay parameters do not match the original reservation');
  }
  const reservedSummary = addUsageSummary(summary, undefined, 0, reservationCost ?? 0);
  assertCostWithinCeiling(ceiling, summary.finalizedCostMicroUsd, reservedSummary.reservedCostMicroUsd);
  const event = {
    event: 'reserved', attemptId, at: now, routeIndex, provider: route.provider,
    ...(route.model === undefined ? {} : { model: route.model }),
    reservedCostMicroUsd: reservationCost ?? 0, reservationInputTokens: bounds.inputTokens,
    reservationOutputTokens: bounds.outputTokens, reservationCostKnown,
    reservationFingerprint: fingerprint,
  };
  const nextAudit = [...audit, event];
  validateGenerationAccounting(reservedSummary, nextAudit, existing.data.options);
  return putRecord('generationJobs', id, { ...existing.data, usageSummary: reservedSummary, usageAudit: nextAudit, updatedAt: now });
};

/* Finalize exactly once. Missing/unknown usage intentionally keeps its reservation. */
export const finalizeGenerationAttempt = (id, {
  workerId, leaseId, attemptId, usage, providerUsage = usage, now = Date.now(),
} = {}) => {
  accountingId(attemptId, 'accounting attempt id');
  const existing = getRecord('generationJobs', id);
  requireActiveGenerationLease(existing, { workerId, leaseId, now });
  const { summary, audit } = accountingState(existing.data);
  const reservation = findAccountingEvent(audit, attemptId, 'reserved');
  const priorFinal = findAccountingEvent(audit, attemptId, 'finalized');
  if (priorFinal) {
    let replayUsage;
    let replayReason;
    try { replayUsage = normalizeProviderUsage(providerUsage); }
    catch (error) { replayReason = /overflow|safe integer|range/.test(error.message) ? 'overflow' : 'malformed'; }
    if (!replayUsage && providerUsage?.unknown === true) replayReason = providerUsage.reason;
    const replayFingerprint = sha256(JSON.stringify({ usage: replayUsage ?? { unknown: true, reason: replayReason ?? 'missing' } }));
    if (replayFingerprint !== priorFinal.finalizationFingerprint) throw new Error('Generation accounting finalization replay parameters do not match the original');
    return existing;
  }
  if (!reservation) {
    throw new Error('Generation accounting attempt has no reservation');
  }
  const route = accountingRoute(existing.data, reservation.routeIndex);
  let normalized;
  let unknownReason;
  try {
    normalized = normalizeProviderUsage(providerUsage);
  } catch (error) {
    unknownReason = /overflow|safe integer|range/.test(error.message) ? 'overflow' : 'malformed';
  }
  if (!normalized && providerUsage?.unknown === true) unknownReason = providerUsage.reason;
  const finalizedCostMicroUsd = normalized ? estimateRouteCost(route, normalized) : undefined;
  const knownCost = finalizedCostMicroUsd !== undefined;
  const ceiling = accountingCeiling(existing.data);
  // Remove this attempt's reservation before checking the final charge, then
  // add the authoritative route-priced result. Other reservations remain held.
  const availableReserved = summary.reservedCostMicroUsd - reservation.reservedCostMicroUsd;
  if (availableReserved < 0) throw new Error('Generation accounting reservation balance is invalid');
  const nextSummary = addUsageSummary(summary, normalized, knownCost ? finalizedCostMicroUsd : 0, 0);
  nextSummary.reservedCostMicroUsd = knownCost ? availableReserved : summary.reservedCostMicroUsd;
  const overCeiling = knownCost && ceiling !== undefined
    && BigInt(nextSummary.finalizedCostMicroUsd) + BigInt(nextSummary.reservedCostMicroUsd) > BigInt(ceiling);
  const event = {
    event: 'finalized', attemptId, at: now, routeIndex: reservation.routeIndex, provider: reservation.provider,
    ...(reservation.model === undefined ? {} : { model: reservation.model }), finalizedCostMicroUsd: knownCost ? finalizedCostMicroUsd : 0,
    reservationReleasedMicroUsd: knownCost ? reservation.reservedCostMicroUsd : 0,
    reservationRetained: !knownCost,
    overCeiling,
    ...(knownCost && ceiling !== undefined ? { ceilingAtFinalizationMicroUsd: ceiling } : {}),
    finalizationFingerprint: sha256(JSON.stringify({ usage: normalized
      ? { inputTokens: normalized.inputTokens, outputTokens: normalized.outputTokens, totalTokens: normalized.totalTokens }
      : { unknown: true, reason: unknownReason ?? 'missing' } })),
    usage: normalized ?? { unknown: true, reason: unknownReason ?? 'missing' },
  };
  const nextAudit = [...audit, event];
  validateGenerationAccounting(nextSummary, nextAudit, existing.data.options);
  return putRecord('generationJobs', id, { ...existing.data, usageSummary: nextSummary, usageAudit: nextAudit, updatedAt: now });
};

/* Raising a finite ceiling is an explicit, auditable service operation. */
export const raiseGenerationCostCeiling = (id, {
  newCeilingMicroUsd, reason, confirmed = false, now = Date.now(),
} = {}) => {
  validateMicroUsd(newCeilingMicroUsd, 'New cost ceiling');
  if (confirmed !== true) throw new Error('Raising a generation cost ceiling requires explicit confirmation');
  if (typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 500) throw new Error('Cost ceiling raise reason is invalid');
  const existing = getRecord('generationJobs', id);
  if (!existing) throw new Error('Generation job not found');
  if (!['paused', 'error', 'waiting'].includes(existing.data.status)) throw new Error('Cost ceiling can only be raised for a paused, waiting, or error job');
  const currentCeiling = accountingCeiling(existing.data);
  if (currentCeiling === undefined) throw new Error('An unlimited generation job has no ceiling to raise');
  if (newCeilingMicroUsd <= currentCeiling) throw new Error('A raised cost ceiling must be greater than its current ceiling');
  const { summary, audit } = accountingState(existing.data);
  const nextOptions = { ...existing.data.options, costCeilingMicroUsd: newCeilingMicroUsd };
  const nextAudit = [...audit, {
    event: 'ceiling-raised', at: now, previousCeilingMicroUsd: currentCeiling,
    newCeilingMicroUsd, reason: reason.trim(),
  }];
  validateGenerationAccounting(summary, nextAudit, nextOptions);
  return putRecord('generationJobs', id, { ...existing.data, options: nextOptions, usageAudit: nextAudit, updatedAt: now });
};

export const getGenerationAccounting = id => {
  const record = getRecord('generationJobs', id);
  if (!record) throw new Error('Generation job not found');
  const { summary, audit } = accountingState(record.data);
  return { summary, audit };
};

// Provider-facing aliases keep the accounting contract discoverable without
// exposing a second implementation.
export const reserveProviderAttempt = reserveGenerationAttempt;
export const finalizeProviderAttempt = finalizeGenerationAttempt;
export const raiseCostCeiling = raiseGenerationCostCeiling;

const generationPatchKeys = new Set([
  'activeRouteIndex', 'coveragePlan', 'error', 'errorCode', 'nextAttemptAt', 'options',
  'progress', 'providerAttempts', 'questions', 'rejected', 'rejections', 'rounds', 'status',
]);
const workerStatuses = new Set(['running', 'waiting', 'paused', 'error']);
const generationQuestionTypes = new Set(['multiple-choice', 'fill-blank', 'reasoning', 'coding']);

const validateGenerationPatch = (patch, job = {}) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new Error('A generation job patch is required');
  }
  const unsupported = Object.keys(patch).filter(key => !generationPatchKeys.has(key));
  if (unsupported.length) throw new Error(`Generation workers cannot update: ${unsupported.join(', ')}`);
  if (patch.status !== undefined && !workerStatuses.has(patch.status)) throw new Error('Invalid worker generation status');
  const checkpointJob = { ...job, ...(patch.options ? { options: patch.options } : {}) };
  if (patch.questions !== undefined) validateQuestionCheckpoint(patch.questions, checkpointJob);
  if (patch.rejected !== undefined && (!Number.isSafeInteger(patch.rejected) || patch.rejected < 0)) {
    throw new Error('Rejected question count must be a non-negative integer');
  }
  if (patch.rejections !== undefined) validateGenerationRejectionTransition(patch.rejections, job.rejections);
  if (patch.rounds !== undefined && (!patch.rounds || typeof patch.rounds !== 'object' || Array.isArray(patch.rounds)
    || Object.entries(patch.rounds).some(([type, round]) => !generationQuestionTypes.has(type) || !Number.isSafeInteger(round) || round < 0 || round > 5))) {
    throw new Error('Generation rounds are invalid');
  }
  const options = patch.options ?? job.options;
  if (patch.options !== undefined) validateGenerationOptions(patch.options, {
    requireSnapshots: isModernGenerationOptions(job.options),
    requireCompleteSettings: Boolean(job.creationFingerprint),
  });
  if (patch.options !== undefined) validateGenerationOptionsTransition(job.options, patch.options);
  if (isModernGenerationOptions(options)) validateActiveRoute(patch.activeRouteIndex ?? job.activeRouteIndex ?? 0, options);
  else if (patch.activeRouteIndex !== undefined) validateActiveRoute(patch.activeRouteIndex, options);
  if (patch.providerAttempts !== undefined) validateProviderAttemptTransition(
    patch.providerAttempts, job.providerAttempts, options, (patch.questions ?? job.questions ?? []).length,
  );
  if (patch.progress !== undefined) validateGenerationProgress(patch.progress, options);
  if (patch.coveragePlan !== undefined) validateCoveragePlan(patch.coveragePlan, job.documentIds, options?.questionCount);
};

export const updateGenerationJobWithLease = (id, { workerId, leaseId, patch, now = Date.now() } = {}) => {
  const existing = getRecord('generationJobs', id);
  validateGenerationPatch(patch, existing?.data);
  requireActiveGenerationLease(existing, { workerId, leaseId, now });
  const running = (patch.status ?? existing.data.status) === 'running';
  return putRecord('generationJobs', id, {
    ...existing.data,
    ...patch,
    updatedAt: now,
    ...(running ? {} : { workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined }),
  });
};

export const completeGenerationJob = (id, {
  workerId, leaseId, completionId, test, patch = {}, now = Date.now(),
} = {}) => {
  if (typeof completionId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(completionId)) throw new Error('Invalid generation completion id');
  if (!test || typeof test !== 'object' || Array.isArray(test) || typeof test.id !== 'string' || !Array.isArray(test.questions)) {
    throw new Error('A completed test record is required');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Generation completion patch must be an object');
  if (Object.hasOwn(patch, 'status')) throw new Error('Generation completion status is managed by the service');
  const existing = getRecord('generationJobs', id);
  validateGenerationPatch({ questions: patch.questions ?? test.questions, ...patch }, existing?.data);
  if (patch.questions && JSON.stringify(patch.questions) !== JSON.stringify(test.questions)) {
    throw new Error('Completed job questions must match the stored test');
  }
  if (existing?.data.status === 'completed' && existing.data.completionId === completionId) {
    const storedTest = getRecord('tests', existing.data.testId);
    if (!storedTest) throw new Error('Completed generation job is missing its test');
    return { job: existing, test: storedTest };
  }
  requireActiveGenerationLease(existing, { workerId, leaseId, now });
  if (test.id !== existing.data.testId) throw new Error('Completed test does not match the generation job');
  if (getRecord('tests', test.id)) throw new Error('Completed test already exists');
  const job = {
    ...existing.data,
    ...patch,
    status: 'completed',
    questions: test.questions,
    completionId,
    finishedAt: now,
    updatedAt: now,
    workerId: undefined,
    leaseId: undefined,
    leaseExpiresAt: undefined,
  };
  syncStorage({
    cursor: Number(currentRevision.get().revision),
    changes: [
      { collection: 'tests', id: test.id, data: test },
      { collection: 'generationJobs', id, data: job },
    ],
  }, { trusted: true });
  return { job: getRecord('generationJobs', id), test: getRecord('tests', test.id) };
};

export const controlGenerationJob = (id, action, changes = {}, now = Date.now()) => {
  if (action !== 'resume' && action !== 'cancel') throw new Error('Invalid generation job action');
  validateLeaseTime(now);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Generation action must be an object');
  const unsupported = Object.keys(changes).filter(key => !['activeRouteIndex', 'options', 'providerAttempts', 'resetRounds'].includes(key));
  if (unsupported.length) throw new Error(`Generation action does not support: ${unsupported.join(', ')}`);
  if (changes.resetRounds !== undefined && typeof changes.resetRounds !== 'boolean') throw new Error('resetRounds must be a boolean');
  const existing = getRecord('generationJobs', id);
  if (!existing) throw new Error('Generation job not found');
  const options = changes.options ?? existing.data.options;
  if (changes.options !== undefined) validateGenerationOptions(changes.options, {
    requireSnapshots: isModernGenerationOptions(existing.data.options),
    requireCompleteSettings: Boolean(existing.data.creationFingerprint),
  });
  if (changes.options !== undefined) validateGenerationOptionsTransition(existing.data.options, changes.options, { allowRouteApproval: true });
  if (isModernGenerationOptions(options)) validateActiveRoute(changes.activeRouteIndex ?? existing.data.activeRouteIndex ?? 0, options);
  else if (changes.activeRouteIndex !== undefined) validateActiveRoute(changes.activeRouteIndex, options);
  if (changes.providerAttempts !== undefined) validateProviderAttemptTransition(
    changes.providerAttempts, existing.data.providerAttempts, options, existing.data.questions?.length ?? 0,
  );
  if (action === 'cancel' && existing.data.status === 'completed') throw new Error('A completed generation job cannot be cancelled');
  if (action === 'resume' && ['running', 'completed'].includes(existing.data.status)) {
    throw new Error(`A ${existing.data.status} generation job cannot be resumed`);
  }
  if (action === 'cancel' && existing.data.status === 'cancelled') return existing;
  const resume = action === 'resume';
  const data = {
    ...existing.data,
    ...(resume && changes.options ? { options: changes.options } : {}),
    ...(resume && changes.providerAttempts ? { providerAttempts: changes.providerAttempts } : {}),
    ...(resume && changes.activeRouteIndex !== undefined ? { activeRouteIndex: changes.activeRouteIndex } : {}),
    ...(resume && changes.resetRounds ? { rounds: {} } : {}),
    status: resume ? 'queued' : 'cancelled',
    updatedAt: now,
    error: undefined,
    errorCode: undefined,
    nextAttemptAt: undefined,
    workerId: undefined,
    leaseId: undefined,
    leaseExpiresAt: undefined,
    ...(resume ? { finishedAt: undefined } : { finishedAt: now }),
  };
  return putRecord('generationJobs', id, data);
};

export const subscribeStorageChanges = listener => {
  if (typeof listener !== 'function') throw new Error('A storage listener function is required');
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const backupDatabase = async destination => database.backup(destination);

export const closeDatabase = () => database.close();

export const storageInfo = () => ({
  databasePath,
  schemaVersion: 2,
  ...(schemaBackupPath ? { schemaBackupPath } : {}),
  revision: Number(currentRevision.get().revision),
});
