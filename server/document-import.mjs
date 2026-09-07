import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { isStoredObjectReference, materializeDocumentImages } from './object-store.mjs';

export const DOCUMENT_EXTRACTION_SCHEMA_VERSION = 1;
export const STRUCTURAL_CHUNKER_VERSION = 1;
export const CHILD_CHUNK_TARGET_TOKENS = 512;
export const PARENT_SECTION_TARGET_TOKENS = 2048;
export const MAX_DOCUMENT_CHUNKS = 10_000;
export const PDFJS_PARSER_VERSION = 'pdfjs-5.3.31';
export const UTF8_PARSER_VERSION = 'utf8-1';

const textExtensions = new Map([
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.markdown', 'text/markdown'],
  ['.json', 'application/json'], ['.csv', 'text/csv'], ['.tsv', 'text/tab-separated-values'],
  ['.html', 'text/html'], ['.htm', 'text/html'],
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');

// This is deliberately conservative and deterministic. It is not intended to
// emulate a provider tokenizer: word/number runs, CJK/Vietnamese characters,
// and punctuation all contribute bounded units, with a four-character floor
// for prose and a one-character floor for code-like text.
export const estimateChunkTokens = value => {
  const text = String(value ?? '').normalize('NFKC');
  if (!text) return 0;
  const lexical = text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const punctuation = text.match(/[^\p{L}\p{N}_\s]/gu)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
  return Math.max(1, lexical + Math.ceil(punctuation / 3), cjk, Math.ceil(text.length / 4));
};

const abortError = reason => {
  const error = Object.assign(new Error('Document chunking cancelled'), { name: 'AbortError' });
  if (reason !== undefined) error.cause = reason;
  return error;
};
const throwIfAborted = signal => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw abortError(signal.reason);
};

const trimRange = (content, start, end) => {
  while (start < end && /\s/u.test(content[start])) start += 1;
  while (end > start && /\s/u.test(content[end - 1])) end -= 1;
  return { start, end };
};

const pageMarker = line => {
  const explicit = line.match(/^\s*---\s*Page\s+(\d+)\s*---\s*$/iu);
  if (explicit) return Number(explicit[1]);
  const legacy = line.match(/^\s*\{(\d+)\}-{20,}\s*$/u);
  return legacy ? Number(legacy[1]) + 1 : undefined;
};

const headingMatch = line => line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u);
const listMatch = line => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
const imageMatch = line => /!\[[^\]]*\]\([^)]*\)|^\s*\[\[\s*(?:image|figure|diagram)\b[^\]]*\]\]/iu.test(line);
const tableLine = line => /^\s*\|.*\|\s*$/.test(line) || /^\s*[^|\n]+\s*\|\s*[^|\n]+/.test(line);
const tableDivider = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const lineRecords = content => {
  const records = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf('\n', start);
    const rawEnd = newline < 0 ? content.length : newline;
    const end = rawEnd > start && content[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    records.push({ start, end, rawEnd, text: content.slice(start, end) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return records;
};

const structuralUnits = (content, signal, maxUnits = MAX_DOCUMENT_CHUNKS) => {
  const lines = lineRecords(content);
  const units = [];
  const breadcrumbs = [];
  let page;
  let index = 0;
  const push = (startLine, endLine, kind, unitPage = page) => {
    if (endLine <= startLine) return;
    const start = lines[startLine].start;
    const end = lines[endLine - 1].end;
    const trimmed = trimRange(content, start, end);
    if (trimmed.end <= trimmed.start) return;
    units.push({ start: trimmed.start, end: trimmed.end, kind, page: unitPage, breadcrumb: breadcrumbs.filter(Boolean).join(' › ') });
    if (units.length > maxUnits) throw new Error(`Document exceeds the ${maxUnits}-chunk limit`);
  };
  while (index < lines.length) {
    if ((index & 255) === 0) throwIfAborted(signal);
    const line = lines[index];
    const markerPage = pageMarker(line.text);
    if (markerPage !== undefined) { page = markerPage; index += 1; continue; }
    if (!line.text.trim()) { index += 1; continue; }
    const heading = headingMatch(line.text);
    if (heading) {
      const depth = heading[1].length;
      breadcrumbs.length = depth - 1;
      breadcrumbs[depth - 1] = heading[2].trim();
      push(index, index + 1, 'heading', page);
      index += 1;
      continue;
    }
    const start = index;
    const fenced = /^\s*(```+|~~~+)/.exec(line.text);
    if (fenced) {
      const fence = fenced[1].slice(0, 3);
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence}`).test(lines[index].text)) {
        if ((index & 255) === 0) throwIfAborted(signal);
        index += 1;
      }
      if (index < lines.length) index += 1;
      push(start, index, 'code', page);
      continue;
    }
    if (tableLine(line.text) && (tableDivider(lines[index + 1]?.text ?? '') || tableLine(lines[index + 1]?.text ?? ''))) {
      index += 1;
      while (index < lines.length && lines[index].text.trim() && tableLine(lines[index].text)) {
        if ((index & 255) === 0) throwIfAborted(signal);
        index += 1;
      }
      push(start, index, 'table', page);
      continue;
    }
    if (listMatch(line.text)) {
      index += 1;
      while (index < lines.length && lines[index].text.trim() && (listMatch(lines[index].text) || /^\s{2,}\S/.test(lines[index].text))) {
        if ((index & 255) === 0) throwIfAborted(signal);
        index += 1;
      }
      push(start, index, 'list', page);
      continue;
    }
    if (imageMatch(line.text)) { push(index, index + 1, 'image', page); index += 1; continue; }
    index += 1;
    while (index < lines.length && lines[index].text.trim()
      && pageMarker(lines[index].text) === undefined && !headingMatch(lines[index].text)
      && !/^\s*(```+|~~~+)/.test(lines[index].text)
      && !listMatch(lines[index].text) && !imageMatch(lines[index].text)) {
      if ((index & 255) === 0) throwIfAborted(signal);
      index += 1;
    }
    push(start, index, 'paragraph', page);
  }
  return units;
};

const splitByLines = (content, unit, targetTokens, signal) => {
  if (estimateChunkTokens(content.slice(unit.start, unit.end)) <= targetTokens) return [unit];
  const lines = [];
  let lineStart = unit.start;
  while (lineStart < unit.end) {
    const newline = content.indexOf('\n', lineStart);
    const rawEnd = newline < 0 ? unit.end : Math.min(unit.end, newline);
    const lineEnd = rawEnd > lineStart && content[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    lines.push({ start: lineStart, end: lineEnd });
    if (newline < 0 || newline >= unit.end) break;
    lineStart = newline + 1;
  }
  const pieces = [];
  let start = unit.start;
  let end = start;
  for (const [lineIndex, line] of lines.entries()) {
    if ((lineIndex & 255) === 0) throwIfAborted(signal);
    const candidateEnd = Math.min(unit.end, line.end);
    const candidate = content.slice(start, candidateEnd);
    if (end > start && estimateChunkTokens(candidate) > targetTokens) {
      const trimmed = trimRange(content, start, end);
      if (trimmed.end > trimmed.start) pieces.push({ ...unit, start: trimmed.start, end: trimmed.end });
      start = line.start;
    }
    end = candidateEnd;
    if (estimateChunkTokens(content.slice(start, end)) > targetTokens && end > start) {
      // A single line can be larger than the budget; split only at character
      // boundaries so the resulting spans remain valid UTF-16 source ranges.
      let cursor = start;
      let pieceIndex = 0;
      while (cursor < end) {
        if ((pieceIndex & 255) === 0) throwIfAborted(signal);
        let cursorEnd = Math.min(end, cursor + targetTokens * 4);
        while (cursorEnd > cursor && estimateChunkTokens(content.slice(cursor, cursorEnd)) > targetTokens) cursorEnd -= 1;
        if (cursorEnd <= cursor) cursorEnd = Math.min(end, cursor + 1);
        const trimmed = trimRange(content, cursor, cursorEnd);
        if (trimmed.end > trimmed.start) pieces.push({ ...unit, start: trimmed.start, end: trimmed.end });
        cursor = cursorEnd;
        pieceIndex += 1;
      }
      start = end;
      end = start;
    }
  }
  if (end > start) {
    const trimmed = trimRange(content, start, end);
    if (trimmed.end > trimmed.start) pieces.push({ ...unit, start: trimmed.start, end: trimmed.end });
  }
  return pieces;
};

const coalesceHeadings = (content, units, targetTokens) => {
  const merged = [];
  for (let index = 0; index < units.length; index += 1) {
    const current = units[index];
    const next = units[index + 1];
    if (current?.kind === 'heading' && next && current.page === next.page
      && estimateChunkTokens(content.slice(current.start, next.end)) <= targetTokens) {
      merged.push({ ...next, start: current.start, breadcrumb: next.breadcrumb || current.breadcrumb });
      index += 1;
    } else merged.push(current);
  }
  return merged;
};

const structuralChunkDocument = (documentId, content, { signal, childTokens = CHILD_CHUNK_TARGET_TOKENS, parentTokens = PARENT_SECTION_TARGET_TOKENS } = {}) => {
  throwIfAborted(signal);
  const units = [];
  for (const unit of coalesceHeadings(content, structuralUnits(content, signal), childTokens)) {
    const pieces = splitByLines(content, unit, childTokens, signal);
    if (units.length + pieces.length > MAX_DOCUMENT_CHUNKS) {
      throw new Error(`Document ${documentId} exceeds the ${MAX_DOCUMENT_CHUNKS}-chunk limit`);
    }
    units.push(...pieces);
  }
  const children = [];
  let parentOrdinal = -1;
  let parentTokenCount = 0;
  let previousBreadcrumb = '';
  for (const unit of units) {
    throwIfAborted(signal);
    const tokens = estimateChunkTokens(content.slice(unit.start, unit.end));
    const startsNewParent = parentOrdinal < 0 || (unit.breadcrumb && unit.breadcrumb !== previousBreadcrumb)
      || (unit.kind === 'heading' && parentTokenCount > 0)
      || parentTokenCount && parentTokenCount + tokens > parentTokens;
    if (startsNewParent) {
      parentOrdinal += 1;
      parentTokenCount = 0;
    }
    const index = children.length;
    const parentId = `${documentId}:parent:${parentOrdinal}`;
    const contentText = content.slice(unit.start, unit.end);
    const textHash = sha256(contentText);
    children.push({
      id: `${documentId}:span:${index}:${textHash.slice(0, 12)}`,
      index,
      page: unit.page,
      start: unit.start,
      end: unit.end,
      textHash,
      parentId,
      breadcrumb: unit.breadcrumb,
      sectionKind: unit.kind,
      tokenCount: tokens,
    });
    parentTokenCount += tokens;
    previousBreadcrumb = unit.breadcrumb;
  }
  // A malformed extractor can produce duplicate/overlapping units. Keep the
  // first deterministic span and never expose ambiguous citation ranges.
  const seen = new Set();
  return children.filter(chunk => {
    const key = `${chunk.start}:${chunk.end}:${chunk.textHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((chunk, index) => ({ ...chunk, index }));
};

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

const applyImageOcr = async (images, ocr, signal) => {
  if (!Array.isArray(images) || typeof ocr !== 'function') return images;
  return Promise.all(images.map(async image => {
    if (!image || typeof image !== 'object' || image.ocrText || typeof image.data !== 'string') return image;
    const binary = Buffer.from(image.data, 'base64');
    const ocrText = await ocr(binary, { name: image.name, mimeType: image.mimeType, signal });
    return typeof ocrText === 'string' && ocrText.trim() ? { ...image, ocrText: ocrText.trim() } : image;
  }));
};

export const extractDocumentBuffer = async (data, {
  name = 'document', mimeType, now = Date.now, extractor, ocr, signal,
} = {}) => {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('Document data must be binary');
  const source = sourceType(name, mimeType);
  const extracted = typeof extractor === 'function'
    ? await extractor(Buffer.from(data), { name, mimeType: source.mimeType, signal })
    : source.isPdf
      ? await extractPdf(Buffer.from(data))
      : { content: Buffer.from(data).toString('utf8'), parserVersion: UTF8_PARSER_VERSION, extractor: 'utf8' };
  if (!extracted || typeof extracted !== 'object' || typeof extracted.content !== 'string') {
    throw new Error('The document extractor returned an invalid result');
  }
  // Canonicalize line endings once, before source spans are created. Every
  // consumer (citations, browser fallback, and indexes) then shares offsets.
  const normalizedContent = extracted.content.replace(/\r\n?/g, '\n');
  if (!normalizedContent.trim()) throw new Error('The document contains no extractable text');
  const extractedAt = now();
  if (!Number.isSafeInteger(extractedAt) || extractedAt < 0) throw new Error('Invalid extraction time');
  return {
    ...extracted,
    content: normalizedContent,
    images: await applyImageOcr(extracted.images, ocr, signal),
    mimeType: source.mimeType,
    extractionSchemaVersion: DOCUMENT_EXTRACTION_SCHEMA_VERSION,
    extractedAt,
    extractionContentHash: sha256(normalizedContent),
  };
};

const legacyChunkDocument = (documentId, content, targetCharacters = 2200) => {
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

/**
 * Build stable source spans. The default structural mode recognizes document
 * blocks and packs them into bounded child and parent sections. A numeric third
 * argument intentionally retains the pre-structural character API for old
 * callers and stored documents that still request it.
 */
export const chunkDocument = (documentId, content, options = undefined) => {
  if (typeof documentId !== 'string' || !documentId) throw new Error('A document id is required');
  if (typeof content !== 'string') throw new Error('Document content must be text');
  if (typeof options === 'number') return legacyChunkDocument(documentId, content, options);
  const resolved = options && typeof options === 'object' ? options : {};
  const childTokens = Number.isSafeInteger(resolved.childTokens) && resolved.childTokens >= 32 && resolved.childTokens <= 4_096
    ? resolved.childTokens : CHILD_CHUNK_TARGET_TOKENS;
  const parentTokens = Number.isSafeInteger(resolved.parentTokens) && resolved.parentTokens >= childTokens && resolved.parentTokens <= 16_384
    ? resolved.parentTokens : PARENT_SECTION_TARGET_TOKENS;
  return structuralChunkDocument(documentId, content, { ...resolved, childTokens, parentTokens });
};

const pageForOffset = (content, offset) => {
  const markers = [...content.matchAll(/---\s*Page\s+(\d+)\s*---/gi)].filter(match => (match.index ?? 0) <= offset);
  const page = Number(markers.at(-1)?.[1]);
  return page || undefined;
};

export const importDocumentFile = async (path, {
  tags = [], objectStore, now = Date.now, extractor, ocr, signal,
} = {}) => {
  const absolutePath = resolve(path);
  const details = await stat(absolutePath);
  if (!details.isFile()) throw new Error('Document path must refer to a file');
  if (details.size > 250 * 1024 * 1024) throw new Error('Documents larger than 250 MB must be imported from the desktop app');
  const data = await readFile(absolutePath);
  const extracted = await extractDocumentBuffer(data, { name: absolutePath, now, extractor, ocr, signal });
  const id = randomUUID();
  const originalMetadata = {
    type: extracted.mimeType,
    name: basename(absolutePath),
    lastModified: Math.round(details.mtimeMs),
  };
  const document = {
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
    chunkingVersion: STRUCTURAL_CHUNKER_VERSION,
    extractedAt: extracted.extractedAt,
    extractionContentHash: extracted.extractionContentHash,
    chunks: chunkDocument(id, extracted.content, { signal }),
    images: extracted.images,
    originalFile: objectStore ? await objectStore.putBuffer(data, originalMetadata) : {
      __quizzerBlob: true,
      ...originalMetadata,
      data: `data:${originalMetadata.type};base64,${data.toString('base64')}`,
    },
  };
  return objectStore ? (await materializeDocumentImages(document, objectStore)).document : document;
};

const extractionRevision = document => ({
  parserVersion: document.parserVersion || 'unknown',
  extractionSchemaVersion: document.extractionSchemaVersion ?? 0,
  extractedAt: document.extractedAt ?? document.createdAt,
  extractionContentHash: document.extractionContentHash || sha256(document.content || ''),
});

export const reextractDocument = async (document, {
  objectStore, now = Date.now, extractor, ocr, signal,
} = {}) => {
  if (!document || typeof document !== 'object' || typeof document.id !== 'string') throw new Error('A stored document is required');
  if (!objectStore || typeof objectStore.readBuffer !== 'function') throw new Error('Re-extraction requires object storage');
  if (!isStoredObjectReference(document.originalFile)) throw new Error('The verified original file is unavailable for re-extraction');
  const data = await objectStore.readBuffer(document.originalFile.sha256);
  const sourceHash = sha256(data);
  if (sourceHash !== document.originalFile.sha256 || (document.contentHash && sourceHash !== document.contentHash)) {
    throw new Error('The stored original does not match the document content hash');
  }
  const extracted = await extractDocumentBuffer(data, {
    name: document.name, mimeType: document.mimeType, now, extractor, ocr, signal,
  });
  const history = [...(Array.isArray(document.extractionHistory) ? document.extractionHistory : []), extractionRevision(document)].slice(-20);
  const reextracted = {
    ...document,
    content: extracted.content,
    contentHash: sourceHash,
    mimeType: extracted.mimeType,
    pageCount: extracted.pageCount,
    parserVersion: extracted.parserVersion,
    extractionSchemaVersion: extracted.extractionSchemaVersion,
    chunkingVersion: STRUCTURAL_CHUNKER_VERSION,
    extractedAt: extracted.extractedAt,
    extractionContentHash: extracted.extractionContentHash,
    extractionHistory: history,
    chunks: chunkDocument(document.id, extracted.content, { signal }),
    images: extracted.images,
    indexedAt: undefined,
    indexVersion: undefined,
    documentVersionHash: undefined,
  };
  return (await materializeDocumentImages(reextracted, objectStore)).document;
};
