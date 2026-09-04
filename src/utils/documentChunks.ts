import type { StoredDocumentChunk } from '../db/db';

const DEFAULT_CHUNK_CHARACTERS = 3_600;
const MINIMUM_SPLIT_FRACTION = 0.55;

const trimRange = (content: string, start: number, end: number) => {
  while (start < end && /\s/.test(content[start])) start++;
  while (end > start && /\s/.test(content[end - 1])) end--;
  return { start, end };
};

const splitRange = (content: string, rangeStart: number, rangeEnd: number, page: number | undefined, firstIndex: number) => {
  const chunks: StoredDocumentChunk[] = [];
  let start = rangeStart;
  while (start < rangeEnd) {
    let end = Math.min(rangeEnd, start + DEFAULT_CHUNK_CHARACTERS);
    if (end < rangeEnd) {
      const minimum = start + Math.floor(DEFAULT_CHUNK_CHARACTERS * MINIMUM_SPLIT_FRACTION);
      const paragraphBreak = content.lastIndexOf('\n\n', end);
      const wordBreak = content.lastIndexOf(' ', end);
      if (paragraphBreak >= minimum) end = paragraphBreak;
      else if (wordBreak >= minimum) end = wordBreak;
    }
    const trimmed = trimRange(content, start, end);
    if (trimmed.end > trimmed.start) {
      const index = firstIndex + chunks.length;
      chunks.push({ id: `chunk-${index}`, index, page, start: trimmed.start, end: trimmed.end });
    }
    start = Math.max(end, start + 1);
  }
  return chunks;
};

export const chunkDocumentContent = (content: string): StoredDocumentChunk[] => {
  if (!content.trim()) return [];
  const pagePattern = /^(?:--- Page (\d+) ---|\{(\d+)\}-{20,})$/gm;
  const markers = [...content.matchAll(pagePattern)];
  if (!markers.length) return splitRange(content, 0, content.length, undefined, 0);

  const chunks: StoredDocumentChunk[] = [];
  const leadingEnd = markers[0].index ?? 0;
  chunks.push(...splitRange(content, 0, leadingEnd, undefined, chunks.length));
  for (const [position, marker] of markers.entries()) {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = position + 1 < markers.length ? markers[position + 1].index ?? content.length : content.length;
    const page = marker[1] ? Number(marker[1]) : Number(marker[2]) + 1;
    chunks.push(...splitRange(content, start, end, page, chunks.length));
  }
  return chunks;
};

export const chunkText = (content: string, chunk: StoredDocumentChunk) => content.slice(chunk.start, chunk.end);
