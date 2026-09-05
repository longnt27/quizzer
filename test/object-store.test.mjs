import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { isStoredObjectReference, materializeSerializedObjects, ObjectStore } from '../server/object-store.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-object-store-test-'));
const store = new ObjectStore(directory, { maxObjectBytes: 1024 });
test.after(async () => rm(directory, { recursive: true, force: true }));

test('stores, verifies, deduplicates, and lists content-addressed objects', async () => {
  const data = Buffer.from('immutable quiz source');
  const digest = createHash('sha256').update(data).digest('hex');
  const first = await store.putStream(Readable.from([data]), digest, { type: 'text/plain', contentLength: data.length });
  const second = await store.putBuffer(data, { name: 'source.txt' });
  assert.equal(first.sha256, digest);
  assert.equal(first.size, data.length);
  assert.equal(second.sha256, digest);
  assert.equal(isStoredObjectReference(second), true);
  assert.deepEqual(await readFile(store.pathFor(digest)), data);
  assert.deepEqual((await store.list()).map(item => item.sha256), [digest]);
});

test('rejects a mismatched id before making an object visible', async () => {
  const data = Buffer.from('does not match');
  const wrong = '0'.repeat(64);
  await assert.rejects(store.putStream(Readable.from([data]), wrong, { contentLength: data.length }), /hash mismatch/);
  await assert.rejects(store.stat(wrong), /ENOENT/);
});

test('materializes legacy serialized blobs without retaining base64 in records', async () => {
  const value = {
    id: 'doc',
    originalFile: {
      __quizzerBlob: true,
      type: 'text/plain',
      name: 'guide.txt',
      lastModified: 123,
      data: `data:text/plain;base64,${Buffer.from('guide').toString('base64')}`,
    },
  };
  const materialized = await materializeSerializedObjects(value, store);
  assert.equal(materialized.originalFile.__quizzerObject, true);
  assert.equal(materialized.originalFile.name, 'guide.txt');
  assert.equal(await readFile(store.pathFor(materialized.originalFile.sha256), 'utf8'), 'guide');
  assert.equal(JSON.stringify(materialized).includes('__quizzerBlob'), false);
});
