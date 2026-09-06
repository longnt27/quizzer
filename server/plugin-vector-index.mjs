import {
  denseDocumentVersionHash, denseSourceRows, embedDenseRows, validateDenseVectors,
} from './dense-index.mjs';

const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MAX_DOCUMENT_CHUNKS = 10_000;
const MAX_INDEX_PAYLOAD_BYTES = 250 * 1024 * 1024;
const MAX_DOCUMENT_IDS = 10_000;
const MAX_TAGS = 100;
const MAX_DIMENSIONS = 8_192;

const unavailable = message => Object.assign(new Error(message), { code: 'provider_unavailable' });
const isAbort = (error, signal) => signal?.aborted || error?.name === 'AbortError';

const boundedString = (value, label, maximum = 1_024) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
};

const requireReady = (component, plugin) => {
  if (!plugin || plugin.status !== 'installed' || !plugin.enabled || !plugin.compatible
    || !plugin.capabilities?.includes('vector-index')) {
    throw unavailable(`Vector-index plugin ${component} is not installed, enabled, and compatible`);
  }
  const filesystem = plugin.permissions?.filesystem ?? [];
  if (!filesystem.includes('scoped-temp') || !filesystem.includes('persistent-data')) {
    throw unavailable(`Vector-index plugin ${component} must declare scoped-temp and persistent-data permissions`);
  }
};

const pluginCall = async (manager, component, method, params, options = {}) => {
  try {
    return (await manager.invoke(component, method, params, options)).result;
  } catch (error) {
    if (isAbort(error, options.signal)) throw error;
    throw unavailable(`Vector-index plugin ${component} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const indexRows = (sourceRows, vectors) => sourceRows.map((row, index) => {
  const tags = JSON.parse(row.tags_json);
  if (!Array.isArray(tags) || tags.length > MAX_TAGS
    || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 200)) {
    throw new Error(`Vector-index source row ${index + 1} tags are invalid`);
  }
  return {
    sourceSpanId: boundedString(row.span_id, `Vector-index source row ${index + 1} sourceSpanId`, 500),
    documentId: boundedString(row.document_id, `Vector-index source row ${index + 1} documentId`, 500),
    documentName: boundedString(row.document_name, `Vector-index source row ${index + 1} documentName`, 1_024),
    chunkIndex: row.chunk_index,
    parentId: boundedString(row.parent_id, `Vector-index source row ${index + 1} parentId`, 500),
    page: row.page,
    tags,
    contentHash: row.content_hash,
    vector: vectors[index],
  };
});

const validateIndexResult = (result, expectedChunks) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.reused !== 'boolean' || result.chunks !== expectedChunks) {
    throw new Error(`Vector-index plugin must confirm exactly ${expectedChunks} indexed chunks`);
  }
  return result.reused;
};

export const validateVectorSearchResults = (matches, limit) => {
  if (!Array.isArray(matches) || matches.length > limit) {
    throw new Error(`Vector-index plugin returned more than ${limit} matches`);
  }
  const seen = new Set();
  return matches.map((match, index) => {
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      throw new Error(`Vector-index plugin match ${index + 1} is invalid`);
    }
    const sourceSpanId = boundedString(match.sourceSpanId, `Vector-index plugin match ${index + 1} sourceSpanId`, 500);
    if (seen.has(sourceSpanId)) throw new Error(`Vector-index plugin returned duplicate source span ${sourceSpanId}`);
    seen.add(sourceSpanId);
    const documentId = boundedString(match.documentId, `Vector-index plugin match ${index + 1} documentId`, 500);
    if (!Number.isFinite(match.score) || match.score < 0 || match.score > 1) {
      throw new Error(`Vector-index plugin match ${index + 1} score must be from 0 to 1`);
    }
    if (!Array.isArray(match.tags) || match.tags.length > MAX_TAGS
      || match.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 200)) {
      throw new Error(`Vector-index plugin match ${index + 1} tags are invalid`);
    }
    return { sourceSpanId, documentId, tags: [...match.tags], score: match.score };
  });
};

const validateStatus = (result, component, identity) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Vector-index plugin status is invalid');
  const engine = boundedString(result.engine, 'Vector-index plugin engine', 100);
  for (const key of ['tableCount', 'chunkCount', 'activeTableCount', 'activeChunkCount']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error(`Vector-index plugin ${key} is invalid`);
  }
  return {
    version: 1,
    engine,
    component,
    identity,
    tableCount: result.tableCount,
    chunkCount: result.chunkCount,
    activeTableCount: result.activeTableCount,
    activeChunkCount: result.activeChunkCount,
    tables: [],
  };
};

export const resolveVectorIndexProvider = async (settings, { loadManager, builtin } = {}) => {
  const component = settings?.values?.['retrieval.vectorIndexPlugin'] ?? 'builtin';
  if (component === 'builtin') {
    if (!builtin) throw new Error('Built-in vector index is unavailable');
    return {
      component,
      identity: 'builtin:lancedb',
      databasePath: builtin.databasePath,
      indexDocument: (...arguments_) => builtin.indexDocument(...arguments_),
      retrieve: (...arguments_) => builtin.retrieve(...arguments_),
      removeDocument: (...arguments_) => builtin.removeDocument(...arguments_),
      status: (...arguments_) => builtin.status(...arguments_),
      close: (...arguments_) => builtin.close(...arguments_),
    };
  }
  if (!pluginIdPattern.test(component) || typeof loadManager !== 'function') {
    throw unavailable(`Vector-index plugin ${component} is not configured correctly`);
  }
  const manager = await loadManager();
  const plugin = (await manager.list()).find(item => item.id === component);
  requireReady(component, plugin);
  const identity = `plugin:${component}@${plugin.version}`;

  return {
    component,
    identity,
    async indexDocument(record, { embeddingModel, embed, force = false, signal } = {}) {
      if (!record || typeof record.id !== 'string' || !record.data || typeof record.data.content !== 'string') {
        throw new Error('A stored document with extracted text is required');
      }
      boundedString(record.id, 'Vector-index document id', 500);
      if (!record.data.content.trim()) throw new Error(`Document ${record.id} contains no indexable text`);
      boundedString(embeddingModel, 'Vector-index embedding model', 500);
      const sourceRows = denseSourceRows(record);
      if (!sourceRows.length || sourceRows.length > MAX_DOCUMENT_CHUNKS) {
        throw new Error(`Vector-index documents require 1 to ${MAX_DOCUMENT_CHUNKS} chunks`);
      }
      const { vectors, dimension } = await embedDenseRows(sourceRows, embed);
      if (dimension > MAX_DIMENSIONS) throw new Error(`Vector-index vectors cannot exceed ${MAX_DIMENSIONS} dimensions`);
      const versionHash = denseDocumentVersionHash(record.data, embeddingModel);
      const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, rows: indexRows(sourceRows, vectors) }));
      if (payload.length > MAX_INDEX_PAYLOAD_BYTES) throw new Error('Vector-index plugin payload exceeds 250 MB');
      const result = await pluginCall(manager, component, 'rag.index', {
        document: {
          id: record.id,
          name: String(record.data.name || record.id).slice(0, 1_024),
          versionHash,
          embeddingModel,
          dimension,
          chunks: sourceRows.length,
        },
        indexIdentity: identity,
        payloadPath: 'index/document.json',
        force: Boolean(force),
      }, {
        signal,
        timeoutMs: 10 * 60_000,
        files: [{ path: 'index/document.json', data: payload }],
        fileLimits: {
          maximumFiles: 1,
          maximumFileBytes: MAX_INDEX_PAYLOAD_BYTES,
          maximumTotalBytes: MAX_INDEX_PAYLOAD_BYTES,
        },
      });
      const reused = validateIndexResult(result, sourceRows.length);
      return {
        id: record.id,
        name: record.data.name,
        versionHash,
        chunks: sourceRows.length,
        reused,
        embeddingModel,
        dimension,
        tableName: identity,
      };
    },
    async retrieve({ vector, embeddingModel, documentIds = [], limit = 10, signal } = {}) {
      const dimension = validateDenseVectors([vector], 1);
      if (dimension > MAX_DIMENSIONS) throw new Error(`Vector-index vectors cannot exceed ${MAX_DIMENSIONS} dimensions`);
      boundedString(embeddingModel, 'Vector-index embedding model', 500);
      if (!Array.isArray(documentIds) || documentIds.length > MAX_DOCUMENT_IDS
        || documentIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 500)) {
        throw new Error(`Vector-index documentIds must contain at most ${MAX_DOCUMENT_IDS} bounded ids`);
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Vector-index retrieval limit must be from 1 to 100');
      const result = await pluginCall(manager, component, 'rag.search', {
        vector,
        embeddingModel,
        indexIdentity: identity,
        documentIds: [...new Set(documentIds)],
        limit,
      }, { signal, timeoutMs: 60_000 });
      return validateVectorSearchResults(result?.matches, limit);
    },
    async removeDocument(documentId, { signal } = {}) {
      boundedString(documentId, 'Vector-index document id', 500);
      const result = await pluginCall(manager, component, 'rag.remove', {
        documentId, indexIdentity: identity,
      }, { signal, timeoutMs: 60_000 });
      if (!result || !Number.isSafeInteger(result.removedChunks) || result.removedChunks < 0) {
        throw new Error('Vector-index plugin returned an invalid removal result');
      }
      return { id: documentId, removedChunks: result.removedChunks };
    },
    async status({ embeddingModel, signal } = {}) {
      boundedString(embeddingModel, 'Vector-index embedding model', 500);
      const result = await pluginCall(manager, component, 'rag.status', {
        indexIdentity: identity, embeddingModel,
      }, { signal, timeoutMs: 30_000 });
      return validateStatus(result, component, identity);
    },
    async close() {},
  };
};
