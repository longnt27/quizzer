import type { StoredDocumentChunk } from '../db/db';

export const CHILD_CHUNK_TARGET_TOKENS = 512;
export const PARENT_SECTION_TARGET_TOKENS = 2048;

export const estimateChunkTokens = (value: string): number => {
  const text = String(value ?? '').normalize('NFKC');
  if (!text) return 0;
  const lexical = text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const punctuation = text.match(/[^\p{L}\p{N}_\s]/gu)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
  return Math.max(1, lexical + Math.ceil(punctuation / 3), cjk, Math.ceil(text.length / 4));
};

type Kind = NonNullable<StoredDocumentChunk['sectionKind']>;
type Unit = { start: number; end: number; page?: number; breadcrumb: string; sectionKind: Kind };
const trimRange = (text: string, start: number, end: number) => {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return { start, end };
};
const pageMarker = (line: string) => {
  const match = line.match(/^\s*---\s*Page\s+(\d+)\s*---\s*$/iu);
  if (match) return Number(match[1]);
  const legacy = line.match(/^\s*\{(\d+)\}-{20,}\s*$/u);
  return legacy ? Number(legacy[1]) + 1 : undefined;
};
const heading = (line: string) => line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u);
const list = (line: string) => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
const image = (line: string) => /!\[[^\]]*\]\([^)]*\)|^\s*\[\[\s*(?:image|figure|diagram)\b[^\]]*\]\]/iu.test(line);
const table = (line: string) => /^\s*\|.*\|\s*$/.test(line) || /^\s*[^|\n]+\s*\|\s*[^|\n]+/.test(line);
const divider = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const unitsFor = (content: string): Unit[] => {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const newline = content.indexOf('\n', cursor);
    const rawEnd = newline < 0 ? content.length : newline;
    const end = rawEnd > cursor && content[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    lines.push({ start: cursor, end, text: content.slice(cursor, end) });
    if (newline < 0) break;
    cursor = newline + 1;
  }
  const units: Unit[] = [];
  const crumbs: string[] = [];
  let page: number | undefined;
  let index = 0;
  const push = (from: number, to: number, sectionKind: Kind) => {
    if (to <= from) return;
    const range = trimRange(content, lines[from].start, lines[to - 1].end);
    if (range.end > range.start) units.push({ ...range, page, breadcrumb: crumbs.filter(Boolean).join(' › '), sectionKind });
  };
  while (index < lines.length) {
    const marker = pageMarker(lines[index].text);
    if (marker !== undefined) { page = marker; index += 1; continue; }
    if (!lines[index].text.trim()) { index += 1; continue; }
    const title = heading(lines[index].text);
    if (title) {
      const depth = title[1].length;
      crumbs.length = depth - 1;
      crumbs[depth - 1] = title[2].trim();
      push(index, index + 1, 'heading');
      index += 1;
      continue;
    }
    const from = index;
    const fence = /^\s*(```+|~~~+)/.exec(lines[index].text);
    if (fence) {
      const fenceStart = fence[1].slice(0, 3);
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fenceStart}`).test(lines[index].text)) index += 1;
      if (index < lines.length) index += 1;
      push(from, index, 'code');
      continue;
    }
    if (table(lines[index].text) && (divider(lines[index + 1]?.text ?? '') || table(lines[index + 1]?.text ?? ''))) {
      index += 1;
      while (index < lines.length && lines[index].text.trim() && table(lines[index].text)) index += 1;
      push(from, index, 'table');
      continue;
    }
    if (list(lines[index].text)) {
      index += 1;
      while (index < lines.length && lines[index].text.trim() && (list(lines[index].text) || /^\s{2,}\S/.test(lines[index].text))) index += 1;
      push(from, index, 'list');
      continue;
    }
    if (image(lines[index].text)) { push(index, index + 1, 'image'); index += 1; continue; }
    index += 1;
    while (index < lines.length && lines[index].text.trim() && pageMarker(lines[index].text) === undefined
      && !heading(lines[index].text) && !/^\s*(```+|~~~+)/.test(lines[index].text)
      && !list(lines[index].text) && !image(lines[index].text)) index += 1;
    push(from, index, 'paragraph');
  }
  return units;
};

const splitUnit = (content: string, unit: Unit, target: number): Unit[] => {
  if (estimateChunkTokens(content.slice(unit.start, unit.end)) <= target) return [unit];
  const result: Unit[] = [];
  let start = unit.start;
  let end = start;
  for (const line of content.slice(unit.start, unit.end).split('\n')) {
    const lineEnd = Math.min(unit.end, end + line.length);
    if (end > start && estimateChunkTokens(content.slice(start, lineEnd)) > target) {
      const range = trimRange(content, start, end);
      if (range.end > range.start) result.push({ ...unit, ...range });
      start = end;
    }
    end = Math.min(unit.end, lineEnd + 1);
  }
  const range = trimRange(content, start, Math.min(unit.end, end));
  if (range.end > range.start) result.push({ ...unit, ...range });
  if (result.length && result.every(piece => estimateChunkTokens(content.slice(piece.start, piece.end)) <= target)) return result;
  const bounded: Unit[] = [];
  let cursor = unit.start;
  while (cursor < unit.end) {
    let end = Math.min(unit.end, cursor + target * 4);
    while (end > cursor && estimateChunkTokens(content.slice(cursor, end)) > target) end -= 1;
    if (end <= cursor) end = Math.min(unit.end, cursor + 1);
    const slice = trimRange(content, cursor, end);
    if (slice.end > slice.start) bounded.push({ ...unit, ...slice });
    cursor = end;
  }
  return bounded.length ? bounded : [unit];
};

export interface ChunkDocumentOptions { signal?: AbortSignal; childTokens?: number; parentTokens?: number }

export const chunkDocumentContent = (content: string, options: ChunkDocumentOptions = {}): StoredDocumentChunk[] => {
  if (!content.trim()) return [];
  if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('Document chunking cancelled'), { name: 'AbortError' });
  const child = Number.isSafeInteger(options.childTokens) && (options.childTokens as number) >= 32 && (options.childTokens as number) <= 4_096 ? options.childTokens as number : CHILD_CHUNK_TARGET_TOKENS;
  const parent = Number.isSafeInteger(options.parentTokens) && (options.parentTokens as number) >= child && (options.parentTokens as number) <= 16_384 ? options.parentTokens as number : PARENT_SECTION_TARGET_TOKENS;
  const chunks: StoredDocumentChunk[] = [];
  let parentIndex = -1;
  let parentSize = 0;
  const seen = new Set<string>();
  for (const unit of unitsFor(content).flatMap(item => splitUnit(content, item, child))) {
    if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('Document chunking cancelled'), { name: 'AbortError' });
    const text = content.slice(unit.start, unit.end);
    const size = estimateChunkTokens(text);
    if (parentIndex < 0 || (unit.sectionKind === 'heading' && parentSize > 0)
      || (parentSize > 0 && parentSize + size > parent)) { parentIndex += 1; parentSize = 0; }
    const key = `${unit.start}:${unit.end}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chunks.push({ id: `chunk-${chunks.length}`, index: chunks.length, page: unit.page, start: unit.start, end: unit.end,
      parentId: `parent-${parentIndex}`, breadcrumb: unit.breadcrumb, sectionKind: unit.sectionKind, tokenCount: size });
    parentSize += size;
  }
  return chunks;
};

export const chunkText = (content: string, chunk: StoredDocumentChunk) => content.slice(chunk.start, chunk.end);
