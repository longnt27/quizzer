import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { chunkDocument } from './document-import.mjs';
import { materializeRuntimeAsset, runningAsSingleExecutable } from './runtime-assets.mjs';

const TABLE_PREFIX = 'quizzer_chunks_';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;
let lanceDbModule;

const loadLanceDb = () => {
  lanceDbModule ??= import('@lancedb/lancedb');
  return lanceDbModule;
};

export const denseDocumentVersionHash = (document, embeddingModel) => sha256(JSON.stringify({
  contentHash: document.contentHash || sha256(document.content),
  parserVersion: document.parserVersion || 'unknown',
  extractionContentHash: document.extractionContentHash || sha256(document.content),
  embeddingModel,
  length: document.content.length,
}));

export const denseSourceRows = record => {
  const document = record.data;
  const sourceChunks = Array.isArray(document.chunks) && document.chunks.length
    ? document.chunks
    : chunkDocument(record.id, document.content);
  return sourceChunks.map((chunk, position) => {
    const start = Number.isSafeInteger(chunk.start) ? Math.max(0, chunk.start) : 0;
    const end = Number.isSafeInteger(chunk.end) ? Math.min(document.content.length, chunk.end) : document.content.length;
    const content = typeof chunk.text === 'string' ? chunk.text.trim() : document.content.slice(start, end).trim();
    const contentHash = chunk.textHash || sha256(content);
    const chunkIndex = Number.isSafeInteger(chunk.index) ? chunk.index : position;
    const candidateId = typeof chunk.id === 'string'
      ? chunk.id.startsWith(`${record.id}:`) ? chunk.id : `${record.id}:${chunk.id}`
      : undefined;
    return {
      span_id: candidateId || `${record.id}:span:${chunkIndex}:${contentHash.slice(0, 12)}`,
      document_id: record.id,
      document_name: String(document.name || record.id),
      chunk_index: chunkIndex,
      parent_id: `${record.id}:parent:${Math.floor(chunkIndex / 4)}`,
      page: Number.isSafeInteger(chunk.page) ? chunk.page : -1,
      tags_json: JSON.stringify(Array.isArray(document.tags) ? document.tags : []),
      content,
      content_hash: contentHash,
    };
  }).filter(row => row.content);
};

export const validateDenseVectors = (vectors, expected, dimension) => {
  if (!Array.isArray(vectors) || vectors.length !== expected || !vectors.length) {
    throw new Error(`Embedding provider returned ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${expected} chunks`);
  }
  const resolvedDimension = dimension ?? vectors[0]?.length;
  if (!Number.isSafeInteger(resolvedDimension) || resolvedDimension < 1
    || vectors.some(vector => !Array.isArray(vector) || vector.length !== resolvedDimension
      || vector.some(value => !Number.isFinite(value)))) {
    throw new Error('Embedding provider returned invalid or inconsistent vectors');
  }
  return resolvedDimension;
};

export const embedDenseRows = async (rows, embed, { batchSize = 250 } = {}) => {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Dense indexing requires at least one source row');
  if (typeof embed !== 'function') throw new Error('Dense indexing requires an embedding provider');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 250) throw new Error('Dense embedding batch size must be from 1 to 250');
  const vectors = [];
  let dimension;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const embedded = await embed(batch.map(row => row.content));
    dimension = validateDenseVectors(embedded, batch.length, dimension);
    vectors.push(...embedded);
  }
  return { vectors, dimension };
};

const tableNameFor = (embeddingModel, dimension) => `${TABLE_PREFIX}${sha256(embeddingModel).slice(0, 12)}_${dimension}`;
const tablePrefixForModel = embeddingModel => `${TABLE_PREFIX}${sha256(embeddingModel).slice(0, 12)}_`;

export class DenseDocumentIndex {
  constructor(databasePath) {
    if (typeof databasePath !== 'string' || !databasePath) throw new Error('Dense index requires a database path');
    this.databasePath = databasePath;
  }

  async #connection() {
    this.connection ??= (async () => {
      if (runningAsSingleExecutable && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
        const appDataDirectory = dirname(dirname(this.databasePath));
        process.env.NAPI_RS_NATIVE_LIBRARY_PATH = await materializeRuntimeAsset(
          'lancedb.node', join(appDataDirectory, 'runtime', 'lancedb.node'),
        );
      }
      const module = await loadLanceDb();
      return module.connect(this.databasePath);
    })();
    return this.connection;
  }

  async #table(name) {
    const connection = await this.#connection();
    return (await connection.tableNames()).includes(name) ? connection.openTable(name) : undefined;
  }

  async indexDocument(record, { embeddingModel, embed, force = false } = {}) {
    if (!record || typeof record.id !== 'string' || !record.data || typeof record.data.content !== 'string') {
      throw new Error('A stored document with extracted text is required');
    }
    if (!record.data.content.trim()) throw new Error(`Document ${record.id} contains no indexable text`);
    if (typeof embeddingModel !== 'string' || !embeddingModel.trim()) throw new Error('Dense indexing requires an embedding model');
    if (typeof embed !== 'function') throw new Error('Dense indexing requires an embedding provider');
    const rows = denseSourceRows(record);
    if (!rows.length) throw new Error(`Document ${record.id} contains no indexable chunks`);
    const versionHash = denseDocumentVersionHash(record.data, embeddingModel);
    const predicate = `document_id = ${sqlString(record.id)}`;

    if (!force) {
      const connection = await this.#connection();
      const existingNames = (await connection.tableNames()).filter(name => name.startsWith(tablePrefixForModel(embeddingModel)));
      for (const name of existingNames) {
        const existingTable = await connection.openTable(name);
        const existing = await existingTable.query().where(predicate).select(['version_hash', 'vector_dimension']).limit(1).toArray();
        if (existing[0]?.version_hash === versionHash) {
          return {
            id: record.id, name: record.data.name, versionHash, chunks: await existingTable.countRows(predicate), reused: true,
            embeddingModel, dimension: Number(existing[0].vector_dimension), tableName: name,
          };
        }
      }
    }

    const { vectors: probeVectors, dimension } = await embedDenseRows(rows, embed);
    const tableName = tableNameFor(embeddingModel, dimension);
    let table = await this.#table(tableName);
    const embeddedRows = rows.map((row, index) => ({
      ...row, vector: probeVectors[index], version_hash: versionHash, embedding_model: embeddingModel, vector_dimension: dimension,
    }));
    if (table) {
      await table.delete(predicate);
      await table.add(embeddedRows);
    } else {
      const connection = await this.#connection();
      table = await connection.createTable(tableName, embeddedRows);
    }
    return {
      id: record.id, name: record.data.name, versionHash, chunks: rows.length, reused: false,
      embeddingModel, dimension, tableName,
    };
  }

  async retrieve({ vector, embeddingModel, documentIds = [], limit = 10 } = {}) {
    const dimension = validateDenseVectors([vector], 1);
    if (typeof embeddingModel !== 'string' || !embeddingModel.trim()) throw new Error('Dense retrieval requires an embedding model');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Dense retrieval limit must be from 1 to 100');
    const table = await this.#table(tableNameFor(embeddingModel, dimension));
    if (!table) return [];
    let query = table.vectorSearch(vector).distanceType('cosine');
    if (documentIds.length) query = query.where(`document_id IN (${[...new Set(documentIds)].map(sqlString).join(', ')})`);
    const rows = await query.select([
      'span_id', 'document_id', 'document_name', 'chunk_index', 'parent_id', 'page', 'tags_json', 'content', 'content_hash', 'version_hash',
      '_distance',
    ]).limit(Math.min(100, limit)).toArray();
    return rows.map(row => ({
      sourceSpanId: row.span_id,
      documentId: row.document_id,
      documentName: row.document_name,
      chunkIndex: Number(row.chunk_index),
      parentId: row.parent_id,
      page: Number(row.page) >= 0 ? Number(row.page) : undefined,
      tags: JSON.parse(row.tags_json),
      excerpt: row.content,
      contentHash: row.content_hash,
      documentVersionHash: row.version_hash,
      distance: Number(row._distance),
      score: Math.max(0, 1 - Number(row._distance)),
    }));
  }

  async removeDocument(documentId) {
    if (typeof documentId !== 'string' || !documentId) throw new Error('A document id is required');
    const connection = await this.#connection();
    const tableNames = (await connection.tableNames()).filter(name => name.startsWith(TABLE_PREFIX));
    let removedChunks = 0;
    for (const name of tableNames) {
      const table = await connection.openTable(name);
      const predicate = `document_id = ${sqlString(documentId)}`;
      removedChunks += await table.countRows(predicate);
      await table.delete(predicate);
    }
    return { id: documentId, removedChunks };
  }

  async status() {
    const connection = await this.#connection();
    const tableNames = (await connection.tableNames()).filter(name => name.startsWith(TABLE_PREFIX)).sort();
    const tables = [];
    for (const name of tableNames) {
      const table = await connection.openTable(name);
      const sample = await table.query().select(['embedding_model', 'vector_dimension']).limit(1).toArray();
      tables.push({
        name,
        embeddingModel: sample[0]?.embedding_model,
        dimension: sample[0] ? Number(sample[0].vector_dimension) : undefined,
        chunks: await table.countRows(),
      });
    }
    return {
      version: 1,
      engine: 'lancedb',
      databasePath: this.databasePath,
      tableCount: tables.length,
      chunkCount: tables.reduce((sum, table) => sum + table.chunks, 0),
      tables,
    };
  }

  async close() {
    if (this.connection) (await this.connection).close();
    this.connection = undefined;
  }
}
