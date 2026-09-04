import type { StoredCoveragePlan, StoredDocument } from '../db/db';
import type { CoverageStrategy } from '../types';
import { chunkDocumentContent, chunkText } from './documentChunks';

const SOURCE_CHARACTER_BUDGET = 54_000;

export const ensureDocumentChunks = (document: StoredDocument): StoredDocument => {
  if (document.chunks?.length) return document;
  return { ...document, chunks: chunkDocumentContent(document.content) };
};

const representativeText = (document: StoredDocument) => {
  const content = document.content.trim();
  if (content.length <= 4_500) return content;
  const section = 1_500;
  const middle = Math.max(section, Math.floor(content.length / 2 - section / 2));
  return `${content.slice(0, section)}\n${content.slice(middle, middle + section)}\n${content.slice(-section)}`;
};

const cosineSimilarity = (left: number[], right: number[]) => {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
};

const embeddingImportance = async (documents: StoredDocument[], signal?: AbortSignal): Promise<number[] | null> => {
  try {
    const response = await fetch('/api/embed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ texts: documents.map(representativeText) }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { embeddings?: number[][] };
    const vectors = payload.embeddings;
    if (!vectors?.length || vectors.length !== documents.length) return null;
    const dimensions = vectors[0]?.length ?? 0;
    if (!dimensions || vectors.some(vector => vector.length !== dimensions)) return null;
    const centroid = Array.from({ length: dimensions }, (_, dimension) =>
      vectors.reduce((sum, vector) => sum + vector[dimension], 0) / vectors.length);
    return vectors.map(vector => Math.max(0.05, cosineSimilarity(vector, centroid)) ** 3);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return null;
  }
};

const weightedDocumentSequence = (documents: StoredDocument[], weights: number[], count: number) => {
  const assigned = documents.map(() => 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || documents.length;
  const sequence: StoredDocument[] = [];
  for (let slot = 0; slot < count; slot++) {
    let selected = 0;
    let highestDeficit = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < documents.length; index++) {
      const deficit = (slot + 1) * weights[index] / totalWeight - assigned[index];
      if (deficit > highestDeficit) {
        highestDeficit = deficit;
        selected = index;
      }
    }
    assigned[selected]++;
    sequence.push(documents[selected]);
  }
  return sequence;
};

const balancedDocumentSequence = (documents: StoredDocument[], count: number) => Array.from({ length: count }, (_, slot) => {
  if (count < documents.length) return documents[Math.floor((slot + 0.5) * documents.length / count)];
  return documents[slot % documents.length];
});

export const buildCoveragePlan = async (
  sourceDocuments: StoredDocument[],
  questionCount: number,
  strategy: CoverageStrategy,
  signal?: AbortSignal,
): Promise<{ documents: StoredDocument[]; plan: StoredCoveragePlan }> => {
  const documents = sourceDocuments.map(ensureDocumentChunks).filter(document => document.chunks?.length);
  if (!documents.length) throw new Error('The selected documents contain no usable text chunks.');

  let weights = documents.map(() => 1);
  if (strategy === 'proportional') weights = documents.map(document => Math.max(1, document.chunks?.length ?? 1));
  if (strategy === 'ai-selected') {
    weights = await embeddingImportance(documents, signal)
      ?? documents.map(document => Math.max(1, Math.log2(document.content.length + 2)));
  }
  const sequenceLength = questionCount * (strategy === 'cross-document' ? 3 : 1);
  const sequence = strategy === 'balanced' || strategy === 'cross-document'
    ? balancedDocumentSequence(documents, sequenceLength)
    : strategy === 'proportional' && sequenceLength >= documents.length
      ? [...documents, ...weightedDocumentSequence(documents, weights, sequenceLength - documents.length)]
      : weightedDocumentSequence(documents, weights, sequenceLength);
  const chunkUsage = new Map<string, number>();
  let sequenceIndex = 0;
  const slots = Array.from({ length: questionCount }, (_, slotIndex) => {
    const sourceCount = strategy === 'cross-document' ? Math.min(documents.length, slotIndex % 5 === 4 ? 3 : 2) : 1;
    const selected: StoredDocument[] = [];
    while (selected.length < sourceCount) {
      const candidate = sequence[sequenceIndex++ % sequence.length];
      if (!selected.some(document => document.id === candidate.id)) selected.push(candidate);
      else if (selected.length === documents.length) break;
    }
    const chunkIndexes = Object.fromEntries(selected.map(document => {
      const used = chunkUsage.get(document.id) ?? 0;
      chunkUsage.set(document.id, used + 1);
      return [document.id, used % Math.max(1, document.chunks?.length ?? 1)];
    }));
    return { documentIds: selected.map(document => document.id), chunkIndexes };
  });
  return { documents, plan: { strategy, createdAt: Date.now(), slots } };
};

export const sourceContextForSlots = (
  documents: StoredDocument[],
  plan: StoredCoveragePlan,
  offset: number,
  count: number,
) => {
  const documentMap = new Map(documents.map(document => [document.id, document]));
  const requestedSlots = plan.slots.slice(offset, offset + count);
  const assignments = requestedSlots.map((slot, index) => `Question ${index + 1}: ${slot.documentIds.map(id => documentMap.get(id)?.name ?? id).join(' + ')}`);
  const references = new Map<string, { document: StoredDocument; chunkIndex: number }>();
  for (const slot of requestedSlots) {
    for (const documentId of slot.documentIds) {
      const document = documentMap.get(documentId);
      if (!document) continue;
      const chunkIndex = slot.chunkIndexes[documentId] ?? 0;
      references.set(`${documentId}:${chunkIndex}`, { document, chunkIndex });
    }
  }
  const sourceEntries = [...references.values()];
  const perEntryBudget = Math.max(800, Math.floor(SOURCE_CHARACTER_BUDGET / Math.max(1, sourceEntries.length)));
  const content = sourceEntries.map(({ document, chunkIndex }, index) => {
    const chunk = document.chunks?.[chunkIndex] ?? document.chunks?.[0];
    const text = chunk ? chunkText(document.content, chunk) : document.content;
    const page = chunk?.page ? ` · page ${chunk.page}` : '';
    return `## Source ${index + 1}: ${document.name}${page}\n${text.slice(0, perEntryBudget)}`;
  }).join('\n\n');
  const selectedIds = [...new Set(requestedSlots.flatMap(slot => slot.documentIds))];
  const images = selectedIds.flatMap(id => (documentMap.get(id)?.images ?? []).slice(0, 1))
    .slice(0, 6).map(image => `data:${image.mimeType};base64,${image.data}`);
  return {
    content,
    images,
    instruction: `Follow this coverage assignment, creating approximately one question for each line:\n${assignments.join('\n')}`,
  };
};
