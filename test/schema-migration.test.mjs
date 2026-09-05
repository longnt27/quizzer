import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import test from 'node:test';

const execute = promisify(execFile);

test('backs up schema v1 before separating rebuildable RAG tables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-schema-migration-test-'));
  const databasePath = join(directory, 'data', 'quizzer.sqlite');
  await mkdir(join(directory, 'data'));
  const seed = new Database(databasePath);
  seed.exec(`
    CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (collection, id));
    CREATE TABLE rag_chunks (rowid INTEGER PRIMARY KEY, document_id TEXT NOT NULL);
    INSERT INTO records VALUES ('tests', 'preserved', '{"id":"preserved"}', 0, 1, 1);
    INSERT INTO rag_chunks (document_id) VALUES ('derived');
    PRAGMA user_version = 1;
  `);
  seed.close();

  try {
    const script = "const storage = await import('./server/storage.mjs'); process.stdout.write(JSON.stringify(storage.storageInfo())); storage.closeDatabase();";
    const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, QUIZZER_APP_DATA_DIR: directory, QUIZZER_DATABASE_PATH: databasePath },
    });
    const info = JSON.parse(stdout);
    assert.equal(info.schemaVersion, 2);
    assert.match(info.schemaBackupPath, /before-schema-v2-/);

    const migrated = new Database(databasePath, { readonly: true });
    assert.equal(migrated.pragma('user_version', { simple: true }), 2);
    assert.equal(migrated.prepare("SELECT id FROM records WHERE id = 'preserved'").get().id, 'preserved');
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'rag_chunks'").get().count, 0);
    migrated.close();

    const backupNames = await readdir(join(directory, 'backups', 'schema'));
    const backupName = backupNames.find(name => name.endsWith('.sqlite'));
    const backup = await readFile(join(directory, 'backups', 'schema', backupName));
    const checksum = await readFile(join(directory, 'backups', 'schema', `${backupName}.sha256`), 'utf8');
    assert.equal(checksum.split(/\s+/)[0], createHash('sha256').update(backup).digest('hex'));
    const original = new Database(join(directory, 'backups', 'schema', backupName), { readonly: true });
    assert.equal(original.prepare("SELECT COUNT(*) AS count FROM rag_chunks").get().count, 1);
    original.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
