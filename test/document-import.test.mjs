import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chunkDocument, importDocumentFile, reextractDocument, UTF8_PARSER_VERSION } from '../server/document-import.mjs';
import { ObjectStore } from '../server/object-store.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-document-test-'));
test.after(async () => rm(directory, { recursive: true, force: true }));

test('imports text with stable metadata, source spans, and normalized tags', async () => {
  const path = join(directory, 'guide.md');
  await writeFile(path, '# Terraform\n\nProviders configure infrastructure.\n\nState tracks resources.\n');
  const document = await importDocumentFile(path, { tags: ['iac', 'iac', ' terraform '] });
  assert.equal(document.name, 'guide.md');
  assert.equal(document.mimeType, 'text/markdown');
  assert.deepEqual(document.tags, ['iac', 'terraform']);
  assert.match(document.contentHash, /^[a-f0-9]{64}$/);
  assert.match(document.extractionContentHash, /^[a-f0-9]{64}$/);
  assert.equal(document.extractionSchemaVersion, 1);
  assert.equal(document.parserVersion, UTF8_PARSER_VERSION);
  assert.match(document.chunks[0].id, new RegExp(`^${document.id}:span:0:`));
  assert.equal(document.originalFile.__quizzerBlob, true);
});

test('chunks long content without losing source coverage', () => {
  const content = ['First section.', 'x'.repeat(3000), 'Last section.'].join('\n\n');
  const chunks = chunkDocument('doc', content, 1000);
  assert.ok(chunks.length >= 5);
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks.at(-1).end, content.length);
  assert.ok(chunks.every(chunk => chunk.end > chunk.start));
});

test('re-extracts only from the verified original and retains bounded converter provenance', async () => {
  const path = join(directory, 'reextract.md');
  const objectStore = new ObjectStore(join(directory, 'reextract-data'));
  await writeFile(path, '# Durable source\n\nThe immutable original wins.\n');
  const imported = await importDocumentFile(path, { objectStore, now: () => 100 });
  const stale = {
    ...imported,
    content: 'stale extracted text',
    parserVersion: 'legacy-parser-0',
    extractionSchemaVersion: 0,
    extractedAt: 50,
    extractionContentHash: 'a'.repeat(64),
    images: [{ name: 'stale.png' }],
    indexedAt: 75,
    indexVersion: 1,
    documentVersionHash: 'b'.repeat(64),
    extractionHistory: Array.from({ length: 20 }, (_value, index) => ({
      parserVersion: `historical-${index}`, extractionSchemaVersion: 1, extractedAt: index,
      extractionContentHash: String(index).padStart(64, '0'),
    })),
  };
  const reextracted = await reextractDocument(stale, { objectStore, now: () => 200 });
  assert.equal(reextracted.content, '# Durable source\n\nThe immutable original wins.\n');
  assert.equal(reextracted.parserVersion, UTF8_PARSER_VERSION);
  assert.equal(reextracted.extractedAt, 200);
  assert.equal(reextracted.originalFile.sha256, imported.originalFile.sha256);
  assert.equal(reextracted.extractionHistory.length, 20);
  assert.deepEqual(reextracted.extractionHistory.at(-1), {
    parserVersion: 'legacy-parser-0', extractionSchemaVersion: 0, extractedAt: 50, extractionContentHash: 'a'.repeat(64),
  });
  assert.equal(reextracted.extractionHistory[0].parserVersion, 'historical-1');
  assert.equal(reextracted.images, undefined);
  assert.equal(reextracted.documentVersionHash, undefined);
  await assert.rejects(reextractDocument({ ...stale, originalFile: undefined }, { objectStore }), /original file is unavailable/);
});
