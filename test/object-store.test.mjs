import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { collectStoredObjectReferences, isStoredObjectReference, materializeDocumentImages, materializeSerializedObjects, ObjectStore } from '../server/object-store.mjs';

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
  assert.deepEqual(await store.readBuffer(digest), data);
  assert.deepEqual((await store.list()).map(item => item.sha256), [digest]);
});

test('rejects a mismatched id before making an object visible', async () => {
  const data = Buffer.from('does not match');
  const wrong = '0'.repeat(64);
  await assert.rejects(store.putStream(Readable.from([data]), wrong, { contentLength: data.length }), /hash mismatch/);
  await assert.rejects(store.stat(wrong), /ENOENT/);
});

test('cleans partial uploads after disk-full writes and remains usable', async () => {
  assert.throws(() => new ObjectStore(directory, { openFile: null }), /Invalid object file opener/);
  let failedPath = '';
  const diskFullStore = new ObjectStore(directory, {
    maxObjectBytes: 1024,
    openFile: async (...arguments_) => {
      const file = await open(...arguments_);
      failedPath = arguments_[0];
      return {
        write: async () => { throw Object.assign(new Error('disk is full'), { code: 'ENOSPC' }); },
        sync: (...syncArguments) => file.sync(...syncArguments),
        close: (...closeArguments) => file.close(...closeArguments),
      };
    },
  });
  await assert.rejects(diskFullStore.putBuffer(Buffer.from('cannot persist')), error => error.code === 'ENOSPC');
  await assert.rejects(readFile(failedPath), /ENOENT/);
  assert.deepEqual(await readdir(join(diskFullStore.root, '.incoming')), []);

  const recovered = await store.putBuffer(Buffer.from('write after recovery'));
  assert.equal(await readFile(store.pathFor(recovered.sha256), 'utf8'), 'write after recovery');
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

test('materializes extracted image data into immutable object references', async () => {
  const imageData = Buffer.from('fake-png-bytes');
  const result = await materializeDocumentImages({
    id: 'visual-document',
    images: [{ id: 'figure-1', name: 'figure.png', mimeType: 'image/png', data: imageData.toString('base64'), page: 2 }],
  }, store);
  assert.equal(result.changed, true);
  assert.equal(result.document.images[0].data, undefined);
  assert.equal(result.document.images[0].object.__quizzerObject, true);
  assert.equal(await readFile(store.pathFor(result.document.images[0].object.sha256), 'utf8'), imageData.toString());
});

test('reports usage and reclaims only old unreferenced objects', async () => {
  const orphan = await store.putBuffer(Buffer.from('orphaned upload'));
  const all = await store.list();
  const referenced = new Set(all.map(object => object.sha256).filter(sha256 => sha256 !== orphan.sha256));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(store.pathFor(orphan.sha256), old, old);
  const status = await store.status(referenced);
  assert.equal(status.unreferencedCount, 1);
  assert.equal(collectStoredObjectReferences({ nested: [...referenced].map(sha256 => ({ __quizzerObject: true, algorithm: 'sha256', sha256, size: 1 })) }).size, referenced.size);
  const pruned = await store.garbageCollect(referenced, { minimumAgeMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(pruned.removed.map(object => object.sha256), [orphan.sha256]);
  assert.equal((await store.status(referenced)).unreferencedCount, 0);
});
