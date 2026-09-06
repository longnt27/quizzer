import { DenseDocumentIndex } from './dense-index.mjs';
import { embedTextsWithOllama } from './embeddings.mjs';
import { fuseHybridRankings, reciprocalRankFusion } from './hybrid-retrieval.mjs';
import { SparseDocumentIndex } from './sparse-index.mjs';
import { rerankRetrieval } from './reranking.mjs';
import { condenseQuery, decomposeQuery, normalizeQuery } from './query-planning.mjs';
import { resolveVectorIndexProvider } from './plugin-vector-index.mjs';

const errorMessage = error => error instanceof Error ? error.message : String(error);
const refusal = 'Quizzer could not find sufficient indexed evidence for this query.';

const throwIfAborted = signal => {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Retrieval cancelled'), { name: 'AbortError' });
};

const unavailableVectorIndex = (component, error) => {
  const reject = async () => { throw error; };
  return {
    component,
    identity: `unavailable:${component}`,
    indexDocument: reject,
    retrieve: reject,
    removeDocument: reject,
    status: reject,
    close: async () => {},
  };
};

/** Applies limit and contextBudget to a flat results array, returning capped results and token estimate. */
const applyBudget = (results, { limit = 10, contextBudget = 4096 } = {}) => {
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  const boundedBudget = Math.max(256, Math.min(65_536, Math.floor(Number(contextBudget) || 4096)));
  const capped = [];
  let estimatedContextTokens = 0;
  for (const result of results) {
    const tokens = Math.ceil((result.content ?? result.excerpt ?? '').length / 4);
    if (capped.length && estimatedContextTokens + tokens > boundedBudget) continue;
    capped.push(result);
    estimatedContextTokens += tokens;
    if (capped.length >= boundedLimit) break;
  }
  return { results: capped, estimatedContextTokens };
};

const sparseConfidence = previews => previews.some(preview => preview.confidence === 'high')
  ? 'high'
  : previews.some(preview => preview.confidence === 'medium') ? 'medium' : 'low';

const fuseSparsePreviews = (previews, planningTrace) => {
  const base = previews[0];
  const confidence = sparseConfidence(previews);
  const results = previews.length === 1
    ? base.results
    : reciprocalRankFusion(previews.map(preview => preview.results)).map(candidate => ({
        ...candidate.records.find(Boolean),
        score: Number(candidate.score.toFixed(6)),
      }));
  return {
    ...base,
    correctivePass: previews.some(preview => preview.correctivePass),
    confidence,
    results,
    planningTrace,
    ...(confidence === 'low' ? { refusal } : { refusal: undefined }),
  };
};

const hybridConfidence = (previews, results) => {
  const top = results[0];
  if (!top) return 'low';
  if (sparseConfidence(previews) === 'high' || top.retrievalChannels.length > 1) return 'high';
  if (sparseConfidence(previews) === 'medium' || (top.denseScore ?? 0) >= 0.55) return 'medium';
  return 'low';
};

export class RetrievalIndex {
  constructor({
    sparsePath, densePath, loadSettings, embed = embedTextsWithOllama, resolveEmbedding, resolveVectorIndex,
    invokeReranker, invokeLocalHyde, onDenseIssue = () => {},
  }) {
    if (typeof loadSettings !== 'function') throw new Error('Retrieval index requires a settings loader');
    if (typeof embed !== 'function') throw new Error('Retrieval index requires an embedding provider');
    this.sparse = new SparseDocumentIndex(sparsePath);
    this.dense = new DenseDocumentIndex(densePath);
    this.loadSettings = loadSettings;
    this.embed = embed;
    this.resolveEmbedding = resolveEmbedding;
    this.resolveVectorIndex = resolveVectorIndex
      ?? (settings => resolveVectorIndexProvider(settings, { builtin: this.dense }));
    this.invokeReranker = invokeReranker;
    this.invokeLocalHyde = invokeLocalHyde;
    this.onDenseIssue = onDenseIssue;
    this.denseUsed = false;
  }

  async configuration() {
    const settings = await this.loadSettings();
    const configuredModel = settings.values['embeddings.model'];
    const embedding = this.resolveEmbedding
      ? await this.resolveEmbedding(settings)
      : {
          identity: configuredModel,
          embed: (texts, options = {}) => this.embed(texts, { ...options, model: configuredModel }),
        };
    if (!embedding || typeof embedding.identity !== 'string' || !embedding.identity.trim() || typeof embedding.embed !== 'function') {
      throw new Error('Embedding provider resolution returned an invalid route');
    }
    const vectorComponent = settings.values['retrieval.vectorIndexPlugin'] ?? 'builtin';
    let vectorIndex;
    try {
      vectorIndex = await this.resolveVectorIndex(settings, { builtin: this.dense });
      if (!vectorIndex || typeof vectorIndex.identity !== 'string' || !vectorIndex.identity.trim()
        || ['indexDocument', 'retrieve', 'removeDocument', 'status'].some(method => typeof vectorIndex[method] !== 'function')) {
        throw new Error('Vector-index provider resolution returned an invalid route');
      }
    } catch (error) {
      vectorIndex = unavailableVectorIndex(vectorComponent, error);
    }
    return {
      settings,
      embeddings: settings.values['embeddings.enabled'],
      embeddingModel: embedding.identity,
      embedding,
      vectorIndex,
      retrievalMode: settings.values['retrieval.mode'],
    };
  }

  async indexDocument(record, options) {
    const sparse = this.sparse.indexDocument(record, options);
    const { embeddings, embeddingModel, embedding, vectorIndex } = await this.configuration();
    if (!embeddings) return { ...sparse, dense: { status: 'disabled', component: vectorIndex.component } };
    this.denseUsed = true;
    try {
      const dense = await vectorIndex.indexDocument(record, {
        ...options,
        embeddingModel,
        embed: texts => embedding.embed(texts, { signal: options?.signal }),
      });
      this.denseIssue = undefined;
      return { ...sparse, dense: { status: 'ready', component: vectorIndex.component, ...dense } };
    } catch (error) {
      this.denseIssue = {
        model: embeddingModel, component: vectorIndex.component, message: errorMessage(error), occurredAt: Date.now(),
      };
      this.onDenseIssue(this.denseIssue, record);
      throw new Error(`Sparse indexing completed, but dense indexing with ${embeddingModel} is unavailable: ${this.denseIssue.message}`, { cause: error });
    }
  }

  indexSparseDocument(record, options) {
    return this.sparse.indexDocument(record, options);
  }

  async status() {
    const sparse = this.sparse.status();
    const { embeddings, embeddingModel, vectorIndex } = await this.configuration();
    const currentIssue = this.denseIssue?.model === embeddingModel && this.denseIssue?.component === vectorIndex.component
      ? this.denseIssue : undefined;
    let dense = {
      version: 1,
      engine: vectorIndex.component === 'builtin' ? 'lancedb' : 'plugin',
      ...(vectorIndex.databasePath ? { databasePath: vectorIndex.databasePath } : {}),
      enabled: embeddings,
      embeddingModel,
      component: vectorIndex.component,
      identity: vectorIndex.identity,
      status: embeddings ? 'not-built' : 'disabled',
      tableCount: 0,
      chunkCount: 0,
      tables: [],
    };
    if (embeddings || this.denseUsed) {
      try {
        const persisted = await vectorIndex.status({ embeddingModel });
        const activeTables = persisted.tables?.filter(table => table.embeddingModel === embeddingModel) ?? [];
        const activeTableCount = persisted.activeTableCount ?? activeTables.length;
        const activeChunkCount = persisted.activeChunkCount ?? activeTables.reduce((sum, table) => sum + table.chunks, 0);
        const status = !embeddings ? 'disabled' : currentIssue ? 'unavailable' : activeChunkCount ? 'ready' : 'not-built';
        dense = {
          ...persisted, enabled: embeddings, embeddingModel, component: vectorIndex.component,
          identity: vectorIndex.identity, status, activeTableCount, activeChunkCount,
        };
      } catch (error) {
        this.denseIssue = {
          model: embeddingModel, component: vectorIndex.component, message: errorMessage(error), occurredAt: Date.now(),
        };
        dense = { ...dense, status: embeddings ? 'unavailable' : 'disabled' };
      }
    }
    const reportedIssue = currentIssue ?? (this.denseIssue?.model === embeddingModel
      && this.denseIssue?.component === vectorIndex.component ? this.denseIssue : undefined);
    if (embeddings && reportedIssue) dense.issue = reportedIssue;
    return { ...sparse, dense };
  }

  async retrieve(options = {}) {
    const { settings, embeddings, embeddingModel, embedding, vectorIndex, retrievalMode } = await this.configuration();
    throwIfAborted(options.signal);
    const retrievalOptions = {
      ...options,
      contextBudget: options.contextBudget ?? settings.values['retrieval.contextBudget'],
    };
    const planningMode = settings.values['retrieval.planning'] || 'none';
    const baseQuery = normalizeQuery(options.query || '');
    let queryVariants = planningMode === 'none' ? [baseQuery] : decomposeQuery(baseQuery);
    if (!queryVariants.length) queryVariants = [baseQuery];
    const planningTrace = {
      mode: planningMode,
      condensedQuery: condenseQuery(baseQuery),
      variants: [...queryVariants],
      fallback: false,
      hyde: false,
    };

    if (planningMode === 'hyde') {
      if (typeof this.invokeLocalHyde !== 'function') {
        planningTrace.fallback = true;
        planningTrace.reason = 'No approved local HyDE callback is configured; multi-query fallback used.';
      } else {
        try {
          const hypothetical = normalizeQuery(await this.invokeLocalHyde(baseQuery, {
            signal: options.signal,
            localOnly: true,
          }));
          throwIfAborted(options.signal);
          if (hypothetical && !queryVariants.some(variant => variant.toLocaleLowerCase() === hypothetical.toLocaleLowerCase())) {
            queryVariants.push(hypothetical);
            planningTrace.variants.push(hypothetical);
            planningTrace.hyde = true;
          } else {
            planningTrace.fallback = true;
            planningTrace.reason = 'The local HyDE callback returned no distinct passage; multi-query fallback used.';
          }
        } catch (error) {
          if (options.signal?.aborted || error?.name === 'AbortError') throw error;
          planningTrace.fallback = true;
          planningTrace.reason = 'The local HyDE callback failed; multi-query fallback used.';
        }
      }
    }

    const requestedLimit = Math.max(1, Math.min(50, Math.floor(Number(retrievalOptions.limit) || 10)));
    const candidateOptions = planningMode === 'none'
      ? retrievalOptions
      : {
          ...retrievalOptions,
          limit: Math.min(50, Math.max(10, requestedLimit * 4)),
          contextBudget: 65_536,
          includeNeighbors: false,
        };
    const sparsePreviews = [];
    for (const [index, variant] of queryVariants.entries()) {
      throwIfAborted(options.signal);
      sparsePreviews.push(this.sparse.retrieve({
        ...candidateOptions,
        query: variant,
        allowCorrectivePass: index === 0,
      }));
    }
    let preview = fuseSparsePreviews(sparsePreviews, planningTrace);

    if (retrievalMode === 'hybrid' && embeddings) {
      try {
        this.denseUsed = true;
        const vectors = await embedding.embed(queryVariants, { signal: options.signal });
        throwIfAborted(options.signal);
        if (!Array.isArray(vectors) || vectors.length !== queryVariants.length) {
          throw new Error(`Embedding provider returned ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${queryVariants.length} query variants`);
        }
        const normalizedTags = (retrievalOptions.tags ?? []).map(tag => tag.toLocaleLowerCase());
        const allDenseResults = [];
        for (const vector of vectors) {
          throwIfAborted(options.signal);
          const dense = await vectorIndex.retrieve({
            vector,
            embeddingModel,
            documentIds: retrievalOptions.documentIds,
            limit: Math.min(100, Math.max(10, requestedLimit * 4)),
            signal: options.signal,
          });
          allDenseResults.push(dense.filter(result => normalizedTags.every(
            tag => result.tags.map(value => String(value).toLocaleLowerCase()).includes(tag),
          )));
        }
        const fused = fuseHybridRankings({
          sparseRankings: sparsePreviews.map(item => item.results),
          denseRankings: allDenseResults,
        });
        const hydratedFused = typeof this.sparse.hydrateResults === 'function'
          ? this.sparse.hydrateResults(fused, { includeNeighbors: false, dropMissing: true })
          : fused;
        const confidence = hybridConfidence(sparsePreviews, hydratedFused);
        this.denseIssue = undefined;
        preview = {
          query: baseQuery,
          method: 'hybrid-rrf',
          correctivePass: sparsePreviews.some(item => item.correctivePass),
          confidence,
          results: hydratedFused,
          planningTrace,
          ...(confidence === 'low' ? { refusal } : {}),
          dense: {
            status: 'ready', component: vectorIndex.component, embeddingModel,
            candidates: allDenseResults.reduce((sum, r) => sum + r.length, 0),
          },
        };
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError') throw error;
        this.denseIssue = {
          model: embeddingModel, component: vectorIndex.component, message: errorMessage(error), occurredAt: Date.now(),
        };
        preview = {
          ...preview,
          requestedMethod: 'hybrid-rrf',
          dense: {
            status: 'unavailable', component: vectorIndex.component, embeddingModel, error: this.denseIssue.message,
          },
        };
      }
    }

    const reranked = await rerankRetrieval({
      query: options.query,
      results: preview.results,
      enabled: settings.values['retrieval.rerank'],
      component: settings.values['retrieval.rerankerPlugin'],
      invokePlugin: this.invokeReranker,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    const budgeted = applyBudget(reranked.results, retrievalOptions);
    const results = typeof this.sparse.hydrateResults === 'function'
      ? this.sparse.hydrateResults(budgeted.results, { includeNeighbors: retrievalOptions.includeNeighbors !== false })
      : budgeted.results;
    const confidence = results.length ? preview.confidence : 'low';
    return {
      ...preview,
      confidence,
      estimatedContextTokens: budgeted.estimatedContextTokens,
      results,
      reranking: reranked.metadata,
      ...(confidence === 'low' ? { refusal } : { refusal: undefined }),
    };
  }

  async removeDocument(id) {
    const sparse = this.sparse.removeDocument(id);
    this.denseUsed = true;
    const { vectorIndex } = await this.configuration();
    const dense = vectorIndex.component === 'builtin'
      ? await vectorIndex.removeDocument(id)
      : await vectorIndex.removeDocument(id).catch(error => ({ id, removedChunks: 0, issue: errorMessage(error) }));
    if (vectorIndex.component !== 'builtin') await this.dense.removeDocument(id);
    return { sparse, dense };
  }

  async close() {
    this.sparse.close();
    await this.dense.close();
  }
}
