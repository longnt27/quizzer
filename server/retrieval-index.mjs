import { DenseDocumentIndex } from './dense-index.mjs';
import { embedTextsWithOllama } from './embeddings.mjs';
import { buildHybridRetrieval } from './hybrid-retrieval.mjs';
import { SparseDocumentIndex } from './sparse-index.mjs';
import { rerankRetrieval } from './reranking.mjs';

const errorMessage = error => error instanceof Error ? error.message : String(error);

export class RetrievalIndex {
  constructor({ sparsePath, densePath, loadSettings, embed = embedTextsWithOllama, invokeReranker, onDenseIssue = () => {} }) {
    if (typeof loadSettings !== 'function') throw new Error('Retrieval index requires a settings loader');
    if (typeof embed !== 'function') throw new Error('Retrieval index requires an embedding provider');
    this.sparse = new SparseDocumentIndex(sparsePath);
    this.dense = new DenseDocumentIndex(densePath);
    this.loadSettings = loadSettings;
    this.embed = embed;
    this.invokeReranker = invokeReranker;
    this.onDenseIssue = onDenseIssue;
    this.denseUsed = false;
  }

  async configuration() {
    const settings = await this.loadSettings();
    return {
      settings,
      embeddings: settings.values['embeddings.enabled'],
      embeddingModel: settings.values['embeddings.model'],
      retrievalMode: settings.values['retrieval.mode'],
    };
  }

  async indexDocument(record, options) {
    const sparse = this.sparse.indexDocument(record, options);
    const { embeddings, embeddingModel } = await this.configuration();
    if (!embeddings) return { ...sparse, dense: { status: 'disabled' } };
    this.denseUsed = true;
    try {
      const dense = await this.dense.indexDocument(record, {
        ...options,
        embeddingModel,
        embed: texts => this.embed(texts, { model: embeddingModel }),
      });
      this.denseIssue = undefined;
      return { ...sparse, dense: { status: 'ready', ...dense } };
    } catch (error) {
      this.denseIssue = { model: embeddingModel, message: errorMessage(error), occurredAt: Date.now() };
      this.onDenseIssue(this.denseIssue, record);
      throw new Error(`Sparse indexing completed, but dense indexing with ${embeddingModel} is unavailable: ${this.denseIssue.message}`, { cause: error });
    }
  }

  indexSparseDocument(record, options) {
    return this.sparse.indexDocument(record, options);
  }

  async status() {
    const sparse = this.sparse.status();
    const { embeddings, embeddingModel } = await this.configuration();
    const currentIssue = this.denseIssue?.model === embeddingModel ? this.denseIssue : undefined;
    let dense = {
      version: 1,
      engine: 'lancedb',
      databasePath: this.dense.databasePath,
      enabled: embeddings,
      embeddingModel,
      status: embeddings ? 'not-built' : 'disabled',
      tableCount: 0,
      chunkCount: 0,
      tables: [],
    };
    if (embeddings || this.denseUsed) {
      try {
        const persisted = await this.dense.status();
        const activeTables = persisted.tables.filter(table => table.embeddingModel === embeddingModel);
        const activeChunkCount = activeTables.reduce((sum, table) => sum + table.chunks, 0);
        const status = !embeddings ? 'disabled' : currentIssue ? 'unavailable' : activeChunkCount ? 'ready' : 'not-built';
        dense = { ...persisted, enabled: embeddings, embeddingModel, status, activeTableCount: activeTables.length, activeChunkCount };
      } catch (error) {
        this.denseIssue = { model: embeddingModel, message: errorMessage(error), occurredAt: Date.now() };
        dense = { ...dense, status: embeddings ? 'unavailable' : 'disabled' };
      }
    }
    if (embeddings && currentIssue) dense.issue = currentIssue;
    return { ...sparse, dense };
  }

  async retrieve(options = {}) {
    const { settings, embeddings, embeddingModel, retrievalMode } = await this.configuration();
    const retrievalOptions = {
      ...options,
      contextBudget: options.contextBudget ?? settings.values['retrieval.contextBudget'],
    };
    const sparse = this.sparse.retrieve(retrievalOptions);
    let preview = sparse;
    if (retrievalMode === 'hybrid' && embeddings) {
      try {
        this.denseUsed = true;
        const [vector] = await this.embed([options.query], { model: embeddingModel, signal: options.signal });
        const normalizedTags = (retrievalOptions.tags ?? []).map(tag => tag.toLocaleLowerCase());
        const dense = (await this.dense.retrieve({
          vector,
          embeddingModel,
          documentIds: retrievalOptions.documentIds,
          limit: Math.min(100, Math.max(10, (Number(retrievalOptions.limit) || 10) * 4)),
        })).filter(result => normalizedTags.every(tag => result.tags.map(value => String(value).toLocaleLowerCase()).includes(tag)));
        this.denseIssue = undefined;
        preview = {
          ...buildHybridRetrieval({
            sparse, denseResults: dense, limit: retrievalOptions.limit, contextBudget: retrievalOptions.contextBudget,
          }),
          dense: { status: 'ready', embeddingModel, candidates: dense.length },
        };
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError') throw error;
        this.denseIssue = { model: embeddingModel, message: errorMessage(error), occurredAt: Date.now() };
        preview = {
          ...sparse,
          requestedMethod: 'hybrid-rrf',
          dense: { status: 'unavailable', embeddingModel, error: this.denseIssue.message },
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
    return { ...preview, results: reranked.results, reranking: reranked.metadata };
  }

  async removeDocument(id) {
    const sparse = this.sparse.removeDocument(id);
    this.denseUsed = true;
    const dense = await this.dense.removeDocument(id);
    return { sparse, dense };
  }

  async close() {
    this.sparse.close();
    await this.dense.close();
  }
}
