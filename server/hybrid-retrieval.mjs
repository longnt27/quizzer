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

export const fuseHybridRankings = ({ sparseRankings, denseRankings } = {}) => {
  if (!Array.isArray(sparseRankings) || !sparseRankings.length || sparseRankings.some(ranking => !Array.isArray(ranking))) {
    throw new Error('At least one sparse retrieval ranking is required');
  }
  if (!Array.isArray(denseRankings) || denseRankings.some(ranking => !Array.isArray(ranking))) {
    throw new Error('Dense retrieval rankings must be arrays');
  }
  const eligibleDense = denseRankings.map(ranking => ranking.filter(
    result => Number.isFinite(result?.score) && result.score >= 0.35,
  ));
  return reciprocalRankFusion([...sparseRankings, ...eligibleDense]).map(candidate => {
    const sparseMatch = candidate.records.slice(0, sparseRankings.length).find(Boolean);
    const denseMatch = candidate.records.slice(sparseRankings.length).find(Boolean);
    const source = sparseMatch ?? denseMatch;
    const content = sparseMatch?.content ?? denseMatch?.excerpt ?? '';
    return {
      ...source,
      content,
      excerpt: sparseMatch?.excerpt ?? content.slice(0, 480),
      parentContent: sparseMatch?.parentContent ?? content,
      neighbors: sparseMatch?.neighbors ?? [],
      bm25: sparseMatch?.bm25,
      denseScore: denseMatch?.score,
      score: Number(candidate.score.toFixed(6)),
      retrievalChannels: [...new Set(candidate.channels.map(
        channel => channel < sparseRankings.length ? 'sparse' : 'dense',
      ))],
    };
  });
};

export const buildHybridRetrieval = ({
  sparse, denseResults, allSparseResults = [], allDenseResults = [], limit = 10, contextBudget = 4096, planningTrace,
} = {}) => {
  if (!sparse || !Array.isArray(sparse.results)) throw new Error('Sparse retrieval results are required');
  const boundedLimit = boundedInteger(limit, 10, 1, 50);
  const boundedBudget = boundedInteger(contextBudget, 4096, 256, 65_536);
  const sparseRankings = allSparseResults.length ? allSparseResults : [sparse.results];
  const denseRankings = allDenseResults.length ? allDenseResults : [denseResults ?? []];
  const fused = fuseHybridRankings({ sparseRankings, denseRankings });

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
    ...(planningTrace ? { planningTrace } : {}),
    ...(confidence === 'low' ? { refusal } : {}),
  };
};
