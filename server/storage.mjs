import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const collections = new Set(['tests', 'documents', 'generationJobs', 'testDrafts', 'profiles', 'promptProfiles']);
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

const validateChange = change => {
  if (!change || !collections.has(change.collection) || typeof change.id !== 'string' || !change.id) {
    throw new Error('Invalid storage change');
  }
  if (!change.deleted && (typeof change.data !== 'object' || change.data === null)) {
    throw new Error('Storage records must contain an object');
  }
};

const applyChanges = database.transaction((changes, bootstrap, migrationId, migrationPayloadHashes) => {
  const now = Date.now();
  const applied = [];
  for (const change of changes) {
    validateChange(change);
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

export const syncStorage = ({ cursor = 0, changes = [], bootstrap = false, migration } = {}, { migrationPayloadHashes } = {}) => {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Array.isArray(changes) || changes.length > 10_000) {
    throw new Error('Invalid storage sync request');
  }
  if (migration && !bootstrap) throw new Error('Legacy migration metadata requires bootstrap mode');
  if (migration) validateMigration(migration);
  const applied = applyChanges(changes, Boolean(bootstrap), migration?.id, migrationPayloadHashes);
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
  validateChange({ collection, id, data });
  syncStorage({ cursor: Number(currentRevision.get().revision), changes: [{ collection, id, data }] });
  return getRecord(collection, id);
};

export const deleteRecord = (collection, id) => {
  validateCollection(collection);
  syncStorage({ cursor: Number(currentRevision.get().revision), changes: [{ collection, id, deleted: true }] });
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

const claimGenerationJobTransaction = database.transaction((workerId, leaseMs, now) => {
  const candidates = recordsInCollection.all('generationJobs').map(decodeRecord).filter(record => {
    const job = record.data;
    return job.status === 'queued'
      || (job.status === 'waiting' && (job.nextAttemptAt ?? 0) <= now)
      || (job.status === 'running' && (!Number.isFinite(job.leaseExpiresAt) || job.leaseExpiresAt <= now));
  }).sort((left, right) => (left.data.createdAt ?? 0) - (right.data.createdAt ?? 0));
  const selected = candidates[0];
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

export const claimGenerationJob = ({ workerId, leaseMs = 45_000, now = Date.now() } = {}) => {
  validateWorker(workerId, leaseMs);
  validateLeaseTime(now);
  return claimGenerationJobTransaction(workerId, leaseMs, now);
};

export const renewGenerationJobLease = (id, { workerId, leaseId, leaseMs = 45_000, now = Date.now() } = {}) => {
  validateWorker(workerId, leaseMs);
  const existing = getRecord('generationJobs', id);
  requireActiveGenerationLease(existing, { workerId, leaseId, now });
  return putRecord('generationJobs', id, { ...existing.data, leaseExpiresAt: now + leaseMs, updatedAt: now });
};

const generationPatchKeys = new Set([
  'activeRouteIndex', 'coveragePlan', 'error', 'errorCode', 'nextAttemptAt', 'options',
  'progress', 'providerAttempts', 'questions', 'rejected', 'rounds', 'status',
]);
const workerStatuses = new Set(['running', 'waiting', 'paused', 'error']);

const validateGenerationPatch = patch => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new Error('A generation job patch is required');
  }
  const unsupported = Object.keys(patch).filter(key => !generationPatchKeys.has(key));
  if (unsupported.length) throw new Error(`Generation workers cannot update: ${unsupported.join(', ')}`);
  if (patch.status !== undefined && !workerStatuses.has(patch.status)) throw new Error('Invalid worker generation status');
};

export const updateGenerationJobWithLease = (id, { workerId, leaseId, patch, now = Date.now() } = {}) => {
  validateGenerationPatch(patch);
  const existing = getRecord('generationJobs', id);
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
  validateGenerationPatch({ questions: patch.questions ?? test.questions, ...patch });
  if (patch.questions && JSON.stringify(patch.questions) !== JSON.stringify(test.questions)) {
    throw new Error('Completed job questions must match the stored test');
  }
  const existing = getRecord('generationJobs', id);
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
  });
  return { job: getRecord('generationJobs', id), test: getRecord('tests', test.id) };
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
