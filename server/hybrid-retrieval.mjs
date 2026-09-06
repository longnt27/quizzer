const RRF_K = 60;
const refusal = 'Quizzer could not find sufficient indexed evidence for this query.';

const boundedInteger = (value, fallback, minimum, maximum) => Math.max(
  minimum, Math.min(maximum, Math.floor(Number(value) || fallback)),
);

export const reciprocalRankFusion = (rankings, { k = RRF_K } = {}) => {
  if (!Array.isArray(rankings) || rankings.some(ranking => !Array.isArray(ranking))) {
    throw new Error('RRF rankings must be arrays');
  }
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('RRF k must be a positive integer');
  const candidates = new Map();
  rankings.forEach((ranking, channelIndex) => {
    const seen = new Set();
    ranking.forEach((result, index) => {
      if (!result || typeof result.sourceSpanId !== 'string' || seen.has(result.sourceSpanId)) return;
      seen.add(result.sourceSpanId);
      const candidate = candidates.get(result.sourceSpanId) ?? {
        sourceSpanId: result.sourceSpanId, score: 0, channels: [], records: [],
      };
      candidate.score += 1 / (k + index + 1);
      candidate.channels.push(channelIndex);
      candidate.records[channelIndex] = result;
      candidates.set(result.sourceSpanId, candidate);
    });
  });
  return [...candidates.values()].sort((left, right) => right.score - left.score
    || left.sourceSpanId.localeCompare(right.sourceSpanId));
};

const hybridResult = candidate => {
  const [sparse, dense] = candidate.records;
  const source = sparse ?? dense;
  return {
    ...source,
    content: sparse?.content ?? dense.excerpt,
    excerpt: sparse?.excerpt ?? dense.excerpt.slice(0, 480),
    parentContent: sparse?.parentContent ?? dense.excerpt,
    neighbors: sparse?.neighbors ?? [],
    bm25: sparse?.bm25,
    denseScore: dense?.score,
    score: Number(candidate.score.toFixed(6)),
    retrievalChannels: candidate.channels.map(channel => channel === 0 ? 'sparse' : 'dense'),
  };
};

export const buildHybridRetrieval = ({
  sparse, denseResults, limit = 10, contextBudget = 4096,
} = {}) => {
  if (!sparse || !Array.isArray(sparse.results) || !Array.isArray(denseResults)) {
    throw new Error('Sparse and dense retrieval results are required');
  }
  const boundedLimit = boundedInteger(limit, 10, 1, 50);
  const boundedBudget = boundedInteger(contextBudget, 4096, 256, 65_536);
  const eligibleDense = denseResults.filter(result => Number.isFinite(result?.score) && result.score >= 0.35);
  const fused = reciprocalRankFusion([sparse.results, eligibleDense]).map(hybridResult);
  const results = [];
  let estimatedContextTokens = 0;
  for (const result of fused) {
    const tokens = Math.ceil(result.content.length / 4);
    if (results.length && estimatedContextTokens + tokens > boundedBudget) continue;
    results.push(result);
    estimatedContextTokens += tokens;
    if (results.length >= boundedLimit) break;
  }
  const top = results[0];
  const confidence = !top
    ? 'low'
    : sparse.confidence === 'high' || top.retrievalChannels.length > 1
      ? 'high'
      : sparse.confidence === 'medium' || (top.denseScore ?? 0) >= 0.55
        ? 'medium'
        : 'low';
  return {
    query: sparse.query,
    method: 'hybrid-rrf',
    correctivePass: sparse.correctivePass,
    confidence,
    estimatedContextTokens,
    results,
    ...(confidence === 'low' ? { refusal } : {}),
  };
};

