import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-storage-test-'));
process.env.QUIZZER_DATABASE_PATH = join(directory, 'quizzer.sqlite');
const { syncStorage } = await import('../server/storage.mjs');

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
