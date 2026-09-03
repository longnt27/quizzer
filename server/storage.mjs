import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const collections = new Set(['tests', 'documents', 'generationJobs', 'testDrafts']);
const databasePath = process.env.QUIZZER_DATABASE_PATH || join(process.cwd(), '.quizzer-data', 'quizzer.sqlite');

mkdirSync(dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
const schemaVersion = Number(database.pragma('user_version', { simple: true }));
if (schemaVersion > 1) throw new Error(`Quizzer database schema ${schemaVersion} is newer than this server supports`);
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
`);
database.pragma('user_version = 1');

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

const validateChange = change => {
  if (!change || !collections.has(change.collection) || typeof change.id !== 'string' || !change.id) {
    throw new Error('Invalid storage change');
  }
  if (!change.deleted && (typeof change.data !== 'object' || change.data === null)) {
    throw new Error('Storage records must contain an object');
  }
};

const applyChanges = database.transaction((changes, bootstrap) => {
  const now = Date.now();
  for (const change of changes) {
    validateChange(change);
    if (bootstrap && recordExists.get(change.collection, change.id)) continue;
    const stored = {
      collection: change.collection,
      id: change.id,
      data: change.deleted ? null : JSON.stringify(change.data),
      deleted: change.deleted ? 1 : 0,
      updatedAt: now,
    };
    const result = insertChange.run(stored);
    upsertRecord.run({ ...stored, revision: Number(result.lastInsertRowid) });
  }
});

export const syncStorage = ({ cursor = 0, changes = [], bootstrap = false } = {}) => {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Array.isArray(changes) || changes.length > 10_000) {
    throw new Error('Invalid storage sync request');
  }
  applyChanges(changes, Boolean(bootstrap));
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

export const storageInfo = () => ({
  databasePath,
  revision: Number(currentRevision.get().revision),
});
