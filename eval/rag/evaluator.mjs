import { SparseDocumentIndex } from '../../server/sparse-index.mjs';

export const RAG_THRESHOLDS = Object.freeze({
  recallAt10: 0.9,
  citationPrecision: 0.95,
  refusalAccuracy: 0.9,
});

const ratio = (numerator, denominator) => denominator ? numerator / denominator : 1;

const validateCorpus = corpus => {
  if (!corpus || corpus.version !== 1 || typeof corpus.id !== 'string' || typeof corpus.language !== 'string') {
    throw new Error('RAG corpus identity and version are required');
  }
  if (!Array.isArray(corpus.documents) || !corpus.documents.length || !Array.isArray(corpus.queries) || !corpus.queries.length) {
    throw new Error(`RAG corpus ${corpus.id} must contain documents and queries`);
  }
  const spanIds = new Set();
  for (const document of corpus.documents) {
    if (typeof document.id !== 'string' || typeof document.name !== 'string' || !Array.isArray(document.chunks) || !document.chunks.length) {
      throw new Error(`RAG corpus ${corpus.id} contains an invalid document`);
    }
    for (const chunk of document.chunks) {
      if (typeof chunk.spanId !== 'string' || !chunk.spanId.startsWith(`${document.id}:`) || typeof chunk.text !== 'string' || !chunk.text.trim()) {
        throw new Error(`RAG corpus ${corpus.id} contains an invalid source span`);
      }
      if (spanIds.has(chunk.spanId)) throw new Error(`RAG corpus ${corpus.id} repeats source span ${chunk.spanId}`);
      spanIds.add(chunk.spanId);
    }
  }
  const queryIds = new Set();
  for (const query of corpus.queries) {
    if (typeof query.id !== 'string' || typeof query.query !== 'string' || typeof query.answerable !== 'boolean') {
      throw new Error(`RAG corpus ${corpus.id} contains an invalid query`);
    }
    if (queryIds.has(query.id)) throw new Error(`RAG corpus ${corpus.id} repeats query ${query.id}`);
    queryIds.add(query.id);
    if (query.answerable && (!Array.isArray(query.relevantSpanIds) || !query.relevantSpanIds.length)) {
      throw new Error(`Answerable query ${query.id} must declare relevant source spans`);
    }
    if (query.relevantSpanIds?.some(spanId => !spanIds.has(spanId))) {
      throw new Error(`Query ${query.id} references a missing source span`);
    }
  }
  return corpus;
};

const storedRecord = document => {
  let offset = 0;
  const chunks = document.chunks.map((chunk, index) => {
    const start = offset;
    offset += chunk.text.length + 2;
    return {
      id: chunk.spanId,
      index,
      start,
      end: start + chunk.text.length,
      page: chunk.page,
      text: chunk.text,
    };
  });
  return {
    id: document.id,
    data: {
      id: document.id,
      name: document.name,
      tags: document.tags ?? [],
      parserVersion: 'rag-gold-v1',
      content: document.chunks.map(chunk => chunk.text).join('\n\n'),
      chunks,
    },
  };
};

export const evaluateRagCorpora = (corpora, { databasePath, limit = 10 } = {}) => {
  if (typeof databasePath !== 'string' || !databasePath) throw new Error('A temporary evaluation database path is required');
  const validated = corpora.map(validateCorpus);
  const index = new SparseDocumentIndex(databasePath);
  const details = [];
  let relevantFound = 0;
  let relevantTotal = 0;
  let correctTopCitations = 0;
  let answerableQueries = 0;
  let correctRefusals = 0;
  let unanswerableQueries = 0;

  try {
    for (const corpus of validated) {
      for (const document of corpus.documents) index.indexDocument(storedRecord(document));
      const documentIds = corpus.documents.map(document => document.id);
      for (const query of corpus.queries) {
        const retrieval = index.retrieve({ query: query.query, documentIds, limit, includeNeighbors: false });
        const retrievedSpanIds = retrieval.results.slice(0, 10).map(result => result.sourceSpanId);
        if (query.answerable) {
          const relevant = new Set(query.relevantSpanIds);
          const found = retrievedSpanIds.filter(spanId => relevant.has(spanId)).length;
          relevantFound += found;
          relevantTotal += relevant.size;
          answerableQueries += 1;
          if (relevant.has(retrievedSpanIds[0])) correctTopCitations += 1;
          details.push({
            corpus: corpus.id,
            language: corpus.language,
            query: query.id,
            answerable: true,
            recallAt10: ratio(found, relevant.size),
            topCitationCorrect: relevant.has(retrievedSpanIds[0]),
            retrievedSpanIds,
          });
        } else {
          unanswerableQueries += 1;
          const refused = retrieval.confidence === 'low' && typeof retrieval.refusal === 'string' && retrieval.refusal.length > 0;
          if (refused) correctRefusals += 1;
          details.push({
            corpus: corpus.id,
            language: corpus.language,
            query: query.id,
            answerable: false,
            refused,
            retrievedSpanIds,
          });
        }
      }
    }
  } finally {
    index.close();
  }

  return {
    metrics: {
      recallAt10: ratio(relevantFound, relevantTotal),
      citationPrecision: ratio(correctTopCitations, answerableQueries),
      refusalAccuracy: ratio(correctRefusals, unanswerableQueries),
    },
    counts: {
      corpora: validated.length,
      answerableQueries,
      unanswerableQueries,
      relevantSpans: relevantTotal,
    },
    details,
  };
};

export const assertRagThresholds = (result, thresholds = RAG_THRESHOLDS) => {
  const failures = Object.entries(thresholds)
    .filter(([metric, threshold]) => result.metrics[metric] < threshold)
    .map(([metric, threshold]) => `${metric} ${(result.metrics[metric] * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(1)}%`);
  if (failures.length) throw new Error(`RAG regression gate failed: ${failures.join('; ')}`);
  return result;
};
