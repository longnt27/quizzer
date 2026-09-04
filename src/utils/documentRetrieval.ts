import type { AISourceReference } from '../types';
import type { StoredDocument, StoredDocumentImage } from '../db/db';
import { chunkDocumentContent, chunkText } from './documentChunks';

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
    id: `${document.id}:${chunk.id}`,
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
