import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  chunkDocument, estimateChunkTokens, importDocumentFile, reextractDocument, UTF8_PARSER_VERSION,
} from '../server/document-import.mjs';
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

test('structural chunks preserve bounded spans and semantic metadata', () => {
  const content = '# Hạ tầng\n\nMạng giúp cộng tác an toàn.\n\n## Ví dụ\n\n```ts\nconst answer = 42;\n```\n\n| Tên | Giá trị |\n| --- | --- |\n| mạng | nhanh |\n\n--- Page 3 ---\n\n- Một mục\n- Hai mục\n\n![Sơ đồ](diagram.png)';
  const chunks = chunkDocument('structured', content);
  assert.ok(chunks.some(chunk => chunk.sectionKind === 'code'));
  assert.ok(chunks.some(chunk => chunk.sectionKind === 'table'));
  assert.ok(chunks.some(chunk => chunk.sectionKind === 'list'));
  assert.ok(chunks.some(chunk => chunk.sectionKind === 'image'));
  assert.equal(chunks.find(chunk => chunk.sectionKind === 'list')?.page, 3);
  assert.equal(chunks.find(chunk => chunk.sectionKind === 'code')?.breadcrumb, 'Hạ tầng › Ví dụ');
  assert.ok(chunks.every(chunk => chunk.end > chunk.start && content.slice(chunk.start, chunk.end).trim()));
  assert.ok(chunks.every(chunk => estimateChunkTokens(content.slice(chunk.start, chunk.end)) <= 512));
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, chunks.length);
  assert.deepEqual(chunkDocument('structured', content), chunks);
});

test('structural chunking honors cancellation before large work', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => chunkDocument('cancelled', 'content', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('structural chunking rejects oversized chunk counts incrementally', () => {
  const tooMany = Array.from({ length: 10_001 }, (_value, index) => `paragraph ${index}`).join('\n\n');
  assert.throws(() => chunkDocument('too-many', tooMany), /10,?000-chunk limit/);
});

test('many short paragraphs remain deterministic and bounded', () => {
  const content = Array.from({ length: 2_000 }, (_value, index) => `Entry ${index}: nội dung kiểm thử.`).join('\n\n');
  const chunks = chunkDocument('many-paragraphs', content);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length <= 2_000);
  assert.equal(chunks.at(-1).end, content.length);
  assert.ok(chunks.every(chunk => chunk.end > chunk.start && chunk.tokenCount && chunk.tokenCount <= 512));
});

test('small headed sections keep breadcrumb and parent boundaries aligned', () => {
  const content = '# Alpha\n\nFirst detail.\n\n## Beta\n\nSecond detail.\n\n# Gamma\n\nThird detail.';
  const chunks = chunkDocument('headed', content);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(chunk => chunk.breadcrumb), ['Alpha', 'Alpha › Beta', 'Gamma']);
  assert.equal(new Set(chunks.map(chunk => chunk.parentId)).size, 3);
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

test('uses injected extractor and OCR routes while materializing plugin images', async () => {
  const path = join(directory, 'plugin-source.md');
  const objectStore = new ObjectStore(join(directory, 'plugin-extraction-data'));
  await writeFile(path, 'original source');
  const extractor = async (_data, options) => {
    assert.equal(options.mimeType, 'text/markdown');
    return {
      content: '# Plugin output',
      parserVersion: 'plugin:dev.quizzer.extractor@1.0.0',
      extractor: 'dev.quizzer.extractor',
      images: [{ name: 'diagram.png', mimeType: 'image/png', data: Buffer.from('diagram').toString('base64') }],
    };
  };
  const ocr = async (data, options) => {
    assert.deepEqual(data, Buffer.from('diagram'));
    assert.equal(options.name, 'diagram.png');
    return 'diagram labels';
  };

  const document = await importDocumentFile(path, { objectStore, extractor, ocr, now: () => 300 });
  assert.equal(document.content, '# Plugin output');
  assert.equal(document.parserVersion, 'plugin:dev.quizzer.extractor@1.0.0');
  assert.equal(document.images[0].data, undefined);
  assert.equal(document.images[0].object.__quizzerObject, true);
  assert.equal(document.images[0].ocrText, 'diagram labels');
  assert.deepEqual(await objectStore.readBuffer(document.images[0].object.sha256), Buffer.from('diagram'));
});
