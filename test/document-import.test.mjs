import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chunkDocument, importDocumentFile } from '../server/document-import.mjs';

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
