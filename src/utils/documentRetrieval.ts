import type { AISourceReference } from '../types';
import type { StoredDocument, StoredDocumentImage } from '../db/db';
import { chunkDocumentContent, chunkText } from './documentChunks';
import { syncNow } from '../db/serverSync';
import { serviceJson } from './serviceApi';

const tokens = (value: string) => [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];

const occurrences = (content: string, token: string) => {
  let count = 0;
  let index = -1;
  while ((index = content.indexOf(token, index + 1)) >= 0 && count < 5) count++;
  return count;
};

export interface RetrievedDocumentContext {
  content: string;
  sources: AISourceReference[];
  images: StoredDocumentImage[];
}

interface ServiceRetrievalResult {
  sourceSpanId: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  page?: number;
  content: string;
  excerpt: string;
}

interface ServiceRetrievalPreview {
  results: ServiceRetrievalResult[];
}

const stableChunkId = (document: StoredDocument, chunkId: string) =>
  chunkId.startsWith(`${document.id}:`) ? chunkId : `${document.id}:${chunkId}`;

export const retrieveDocumentContext = (documents: StoredDocument[], query: string, maxChunks = 8): RetrievedDocumentContext => {
  const queryTokens = tokens(query);
  const candidates = documents.flatMap(document => {
    const chunks = document.chunks?.length ? document.chunks : chunkDocumentContent(document.content);
    const metadata = `${document.name} ${document.tags.join(' ')}`.toLocaleLowerCase();
    return chunks.map(chunk => {
      const text = chunkText(document.content, chunk);
      const searchable = text.toLocaleLowerCase();
      const score = queryTokens.reduce((total, token) => total + occurrences(searchable, token) * 3 + occurrences(metadata, token) * 2, 0);
      return { document, chunk, text, score };
    });
  });
  const hasMatches = candidates.some(candidate => candidate.score > 0);
  const selected = (hasMatches
    ? candidates.filter(candidate => candidate.score > 0).sort((left, right) => right.score - left.score)
    : candidates.filter((_, index) => index === 0 || index % Math.max(1, Math.ceil(candidates.length / maxChunks)) === 0))
    .slice(0, maxChunks);

  const sources = selected.map(({ document, chunk, text }, index) => ({
    id: stableChunkId(document, chunk.id),
    documentId: document.id,
    name: document.name,
    page: chunk.page,
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 1_200),
    index: index + 1,
  }));
  const content = selected.map(({ document, chunk, text }, index) =>
    `[Source ${index + 1}: ${document.name}${chunk.page ? `, page ${chunk.page}` : ''}]\n${text}`).join('\n\n');
  const selectedKeys = new Set(selected.map(({ document, chunk }) => `${document.id}:${chunk.id}`));
  const imageCandidates = documents.flatMap(document => (document.images ?? []).map((image, index) => {
    const metadata = `${image.caption ?? ''} ${image.ocrText ?? ''} ${image.context ?? ''}`.toLocaleLowerCase();
    const metadataScore = queryTokens.reduce((total, token) => total + occurrences(metadata, token) * 2, 0);
    const chunks = document.chunks?.length ? document.chunks : chunkDocumentContent(document.content);
    const linked = chunks.some(chunk => selectedKeys.has(`${document.id}:${chunk.id}`)
      && ((image.page && chunk.page === image.page)
        || (image.sourceStart !== undefined && image.sourceStart >= chunk.start && image.sourceStart < chunk.end)));
    return { image, index, score: metadataScore + (linked ? 20 : 0) };
  }));
  const images = imageCandidates.filter(candidate => candidate.score > 0 || candidate.index === 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(candidate => candidate.image);

  return { content, sources, images };
};

export const retrieveGroundedDocumentContext = async (
  documents: StoredDocument[],
  query: string,
  signal?: AbortSignal,
): Promise<RetrievedDocumentContext> => {
  if (!documents.length) return { content: '', sources: [], images: [] };
  try {
    await syncNow();
    if (signal?.aborted) throw new DOMException('Retrieval cancelled', 'AbortError');
    const preview = await serviceJson<ServiceRetrievalPreview>('/api/v1/retrieval/preview', 'POST', {
      query,
      documentIds: documents.map(document => document.id),
      limit: 8,
      includeNeighbors: true,
    }, { signal });
    const sources = preview.results.map((result, index) => ({
      id: result.sourceSpanId,
      documentId: result.documentId,
      name: result.documentName,
      page: result.page,
      excerpt: result.excerpt,
      index: index + 1,
    }));
    const content = preview.results.map((result, index) =>
      `[Source ${index + 1}: ${result.documentName}${result.page ? `, page ${result.page}` : ''}; span ${result.sourceSpanId}]\n${result.content}`).join('\n\n');
    const resultKeys = new Set(preview.results.map(result => `${result.documentId}:${result.chunkIndex}`));
    const resultPages = new Set(preview.results.flatMap(result => result.page ? [`${result.documentId}:${result.page}`] : []));
    const images = documents.flatMap(document => (document.images ?? []).flatMap(image => {
      const chunks = document.chunks?.length ? document.chunks : chunkDocumentContent(document.content);
      const linked = resultPages.has(`${document.id}:${image.page}`) || chunks.some(chunk => resultKeys.has(`${document.id}:${chunk.index}`)
        && image.sourceStart !== undefined && image.sourceStart >= chunk.start && image.sourceStart < chunk.end);
      return linked ? [image] : [];
    })).slice(0, 4);
    return { content, sources, images };
  } catch (error) {
    if ((error as Error).name === 'AbortError' || signal?.aborted) throw error;
    return retrieveDocumentContext(documents, query);
  }
};
