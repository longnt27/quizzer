const terms = value => new Set(String(value).normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);

const overlap = (left, right) => {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const term of left) if (right.has(term)) intersection += 1;
  return intersection / left.size;
};

const similarity = (left, right) => {
  const leftTerms = terms(left);
  const rightTerms = terms(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  let intersection = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) intersection += 1;
  return intersection / (leftTerms.size + rightTerms.size - intersection);
};

export const builtInRerank = (query, results) => {
  const queryTerms = terms(query);
  return results.map((result, index) => {
    const rankSignal = 1 - index / Math.max(1, results.length);
    const lexicalSignal = overlap(queryTerms, terms(`${result.breadcrumb ?? ''} ${result.content ?? result.excerpt ?? ''}`));
    const denseSignal = Number.isFinite(result.denseScore) ? Math.max(0, Math.min(1, result.denseScore)) : 0;
    return {
      ...result,
      rerankScore: Number((rankSignal * 0.5 + lexicalSignal * 0.25 + denseSignal * 0.25).toFixed(6)),
    };
  }).sort((left, right) => right.rerankScore - left.rerankScore || left.sourceSpanId.localeCompare(right.sourceSpanId));
};

export const maximalMarginalRelevance = (results, { lambda = 0.75 } = {}) => {
  if (!Array.isArray(results)) throw new Error('MMR results must be an array');
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new Error('MMR lambda must be from 0 to 1');
  const remaining = [...results];
  const selected = [];
  while (remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const originalRank = results.indexOf(candidate);
      const relevance = 1 - originalRank / Math.max(1, results.length);
      const redundancy = selected.length
        ? Math.max(...selected.map(item => similarity(candidate.content ?? candidate.excerpt, item.content ?? item.excerpt)))
        : 0;
      const score = lambda * relevance - (1 - lambda) * redundancy;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
};

const applyPluginRanking = (results, response) => {
  if (!response || typeof response !== 'object' || !Array.isArray(response.ranking) || !response.ranking.length) {
    throw new Error('Reranker plugin must return a non-empty ranking array');
  }
  const candidates = new Map(results.map(result => [result.sourceSpanId, result]));
  const seen = new Set();
  const ranked = response.ranking.map(item => {
    if (!item || typeof item.sourceSpanId !== 'string' || !candidates.has(item.sourceSpanId) || seen.has(item.sourceSpanId)) {
      throw new Error('Reranker plugin returned an unknown or duplicate source span');
    }
    if (item.score !== undefined && !Number.isFinite(item.score)) throw new Error('Reranker plugin returned an invalid score');
    seen.add(item.sourceSpanId);
    return { ...candidates.get(item.sourceSpanId), ...(item.score === undefined ? {} : { rerankScore: item.score }) };
  });
  ranked.push(...results.filter(result => !seen.has(result.sourceSpanId)));
  return ranked;
};

export const rerankRetrieval = async ({
  query, results, enabled = false, component = 'builtin', invokePlugin, signal,
} = {}) => {
  if (typeof query !== 'string' || !Array.isArray(results)) throw new Error('A query and retrieval results are required for reranking');
  if (!enabled) return { results, metadata: { status: 'disabled' } };
  let ranked;
  let metadata;
  if (component !== 'builtin') {
    try {
      if (typeof invokePlugin !== 'function') throw new Error('No plugin runtime is available');
      const response = await invokePlugin(component, {
        query,
        candidates: results.map(result => ({
          sourceSpanId: result.sourceSpanId,
          documentId: result.documentId,
          content: String(result.content ?? result.excerpt ?? '').slice(0, 4_000),
          sparseScore: result.score,
          denseScore: result.denseScore,
        })),
      }, { signal });
      ranked = applyPluginRanking(results, response);
      metadata = { status: 'ready', component };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      ranked = builtInRerank(query, results);
      metadata = { status: 'fallback', component: 'builtin', requestedComponent: component, issue: error instanceof Error ? error.message : String(error) };
    }
  } else {
    ranked = builtInRerank(query, results);
    metadata = { status: 'ready', component: 'builtin' };
  }
  return {
    results: maximalMarginalRelevance(ranked),
    metadata: { ...metadata, diversity: 'maximal-marginal-relevance' },
  };
};
