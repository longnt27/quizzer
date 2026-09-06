import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { isStoredObjectReference } from './object-store.mjs';

export const DOCUMENT_EXTRACTION_SCHEMA_VERSION = 1;
export const PDFJS_PARSER_VERSION = 'pdfjs-5.3.31';
export const UTF8_PARSER_VERSION = 'utf8-1';

const textExtensions = new Map([
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.markdown', 'text/markdown'],
  ['.json', 'application/json'], ['.csv', 'text/csv'], ['.tsv', 'text/tab-separated-values'],
  ['.html', 'text/html'], ['.htm', 'text/html'],
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');

const extractPdf = async data => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({ data: new Uint8Array(data), useWorkerFetch: false, isEvalSupported: false }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      pages.push(`--- Page ${pageNumber} ---\n${text.items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim()}`);
    }
  } finally {
    await document.destroy();
  }
  return { content: pages.join('\n\n'), pageCount: pages.length, parserVersion: PDFJS_PARSER_VERSION, extractor: 'pdfjs' };
};

const sourceType = (name, mimeType) => {
  const extension = extname(name).toLowerCase();
  if (mimeType === 'application/pdf' || extension === '.pdf') return { extension: '.pdf', mimeType: 'application/pdf', isPdf: true };
  const resolvedMimeType = textExtensions.get(extension) || (typeof mimeType === 'string' && mimeType.startsWith('text/') ? mimeType : undefined);
  if (!resolvedMimeType) throw new Error(`Unsupported document type: ${extension || mimeType || 'unknown'}`);
  return { extension, mimeType: resolvedMimeType, isPdf: false };
};

export const extractDocumentBuffer = async (data, { name = 'document', mimeType, now = Date.now } = {}) => {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('Document data must be binary');
  const source = sourceType(name, mimeType);
  const extracted = source.isPdf
    ? await extractPdf(Buffer.from(data))
    : { content: Buffer.from(data).toString('utf8'), parserVersion: UTF8_PARSER_VERSION, extractor: 'utf8' };
  if (!extracted.content.trim()) throw new Error('The document contains no extractable text');
  const extractedAt = now();
  if (!Number.isSafeInteger(extractedAt) || extractedAt < 0) throw new Error('Invalid extraction time');
  return {
    ...extracted,
    mimeType: source.mimeType,
    extractionSchemaVersion: DOCUMENT_EXTRACTION_SCHEMA_VERSION,
    extractedAt,
    extractionContentHash: sha256(extracted.content),
  };
};

export const chunkDocument = (documentId, content, targetCharacters = 2200) => {
  const blocks = content.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const chunks = [];
  let text = '';
  let start = 0;
  const append = () => {
    const normalized = text.trim();
    if (!normalized) return;
    const locatedStart = content.indexOf(normalized.slice(0, Math.min(80, normalized.length)), start);
    const actualStart = locatedStart >= 0 ? locatedStart : start;
    const end = Math.min(content.length, actualStart + normalized.length);
    const index = chunks.length;
    chunks.push({
      id: `${documentId}:span:${index}:${sha256(normalized).slice(0, 12)}`,
      index,
      start: actualStart,
      end,
      textHash: sha256(normalized),
    });
    start = end;
    text = '';
  };
  for (const block of blocks) {
    const separator = text ? '\n\n' : '';
    if (text && text.length + separator.length + block.length > targetCharacters) append();
    if (block.length <= targetCharacters) text += `${text ? '\n\n' : ''}${block}`;
    else {
      append();
      for (let offset = 0; offset < block.length; offset += targetCharacters) {
        text = block.slice(offset, offset + targetCharacters);
        append();
      }
    }
  }
  append();
  return chunks.map(chunk => ({ ...chunk, page: pageForOffset(content, chunk.start) }));
};

const pageForOffset = (content, offset) => {
  const markers = [...content.matchAll(/---\s*Page\s+(\d+)\s*---/gi)].filter(match => (match.index ?? 0) <= offset);
  const page = Number(markers.at(-1)?.[1]);
  return page || undefined;
};

export const importDocumentFile = async (path, { tags = [], objectStore, now = Date.now } = {}) => {
  const absolutePath = resolve(path);
  const details = await stat(absolutePath);
  if (!details.isFile()) throw new Error('Document path must refer to a file');
  if (details.size > 250 * 1024 * 1024) throw new Error('Documents larger than 250 MB must be imported from the desktop app');
  const data = await readFile(absolutePath);
  const extracted = await extractDocumentBuffer(data, { name: absolutePath, now });
  const id = randomUUID();
  const originalMetadata = {
    type: extracted.mimeType,
    name: basename(absolutePath),
    lastModified: Math.round(details.mtimeMs),
  };
  return {
    id,
    name: basename(absolutePath),
    createdAt: extracted.extractedAt,
    mimeType: extracted.mimeType,
    size: details.size,
    tags: [...new Set(tags.map(tag => tag.trim()).filter(Boolean))],
    content: extracted.content,
    pageCount: extracted.pageCount,
    contentHash: sha256(data),
    parserVersion: extracted.parserVersion,
    extractionSchemaVersion: extracted.extractionSchemaVersion,
    extractedAt: extracted.extractedAt,
    extractionContentHash: extracted.extractionContentHash,
    chunks: chunkDocument(id, extracted.content),
    originalFile: objectStore ? await objectStore.putBuffer(data, originalMetadata) : {
      __quizzerBlob: true,
      ...originalMetadata,
      data: `data:${originalMetadata.type};base64,${data.toString('base64')}`,
    },
  };
};

const extractionRevision = document => ({
  parserVersion: document.parserVersion || 'unknown',
  extractionSchemaVersion: document.extractionSchemaVersion ?? 0,
  extractedAt: document.extractedAt ?? document.createdAt,
  extractionContentHash: document.extractionContentHash || sha256(document.content || ''),
});

export const reextractDocument = async (document, { objectStore, now = Date.now } = {}) => {
  if (!document || typeof document !== 'object' || typeof document.id !== 'string') throw new Error('A stored document is required');
  if (!objectStore || typeof objectStore.readBuffer !== 'function') throw new Error('Re-extraction requires object storage');
  if (!isStoredObjectReference(document.originalFile)) throw new Error('The verified original file is unavailable for re-extraction');
  const data = await objectStore.readBuffer(document.originalFile.sha256);
  const sourceHash = sha256(data);
  if (sourceHash !== document.originalFile.sha256 || (document.contentHash && sourceHash !== document.contentHash)) {
    throw new Error('The stored original does not match the document content hash');
  }
  const extracted = await extractDocumentBuffer(data, { name: document.name, mimeType: document.mimeType, now });
  const history = [...(Array.isArray(document.extractionHistory) ? document.extractionHistory : []), extractionRevision(document)].slice(-20);
  return {
    ...document,
    content: extracted.content,
    contentHash: sourceHash,
    mimeType: extracted.mimeType,
    pageCount: extracted.pageCount,
    parserVersion: extracted.parserVersion,
    extractionSchemaVersion: extracted.extractionSchemaVersion,
    extractedAt: extracted.extractedAt,
    extractionContentHash: extracted.extractionContentHash,
    extractionHistory: history,
    chunks: chunkDocument(document.id, extracted.content),
    images: undefined,
    indexedAt: undefined,
    indexVersion: undefined,
    documentVersionHash: undefined,
  };
};
