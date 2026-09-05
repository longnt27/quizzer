import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

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
  return { content: pages.join('\n\n'), pageCount: pages.length, parserVersion: 'pdfjs-5' };
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

export const importDocumentFile = async (path, { tags = [], objectStore } = {}) => {
  const absolutePath = resolve(path);
  const details = await stat(absolutePath);
  if (!details.isFile()) throw new Error('Document path must refer to a file');
  if (details.size > 250 * 1024 * 1024) throw new Error('Documents larger than 250 MB must be imported from the desktop app');
  const data = await readFile(absolutePath);
  const extension = extname(absolutePath).toLowerCase();
  const isPdf = extension === '.pdf';
  if (!isPdf && !textExtensions.has(extension)) throw new Error(`Unsupported document type: ${extension || 'unknown'}`);
  const extracted = isPdf
    ? await extractPdf(data)
    : { content: data.toString('utf8'), parserVersion: 'utf8-1' };
  if (!extracted.content.trim()) throw new Error('The document contains no extractable text');
  const id = randomUUID();
  const originalMetadata = {
    type: isPdf ? 'application/pdf' : textExtensions.get(extension),
    name: basename(absolutePath),
    lastModified: Math.round(details.mtimeMs),
  };
  return {
    id,
    name: basename(absolutePath),
    createdAt: Date.now(),
    mimeType: isPdf ? 'application/pdf' : textExtensions.get(extension),
    size: details.size,
    tags: [...new Set(tags.map(tag => tag.trim()).filter(Boolean))],
    content: extracted.content,
    pageCount: extracted.pageCount,
    contentHash: sha256(data),
    parserVersion: extracted.parserVersion,
    chunks: chunkDocument(id, extracted.content),
    originalFile: objectStore ? await objectStore.putBuffer(data, originalMetadata) : {
      __quizzerBlob: true,
      ...originalMetadata,
      data: `data:${originalMetadata.type};base64,${data.toString('base64')}`,
    },
  };
};
