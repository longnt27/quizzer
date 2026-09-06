import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chunkDocument } from './document-import.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalizedTokens = value => String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
const queryTokens = value => [...new Set(normalizedTokens(value))].slice(0, 24);
const quoteToken = token => `"${token.replaceAll('"', '""')}"`;

const headingBreadcrumbs = content => {
  const headings = [];
  const stack = [];
  for (const match of content.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    const depth = match[1].length;
    stack.length = depth - 1;
    stack[depth - 1] = match[2].trim();
    headings.push({ offset: match.index ?? 0, value: stack.filter(Boolean).join(' › ') });
  }
  return headings;
};

const breadcrumbAt = (headings, offset) => {
  let result = '';
  for (const heading of headings) {
    if (heading.offset > offset) break;
    result = heading.value;
  }
  return result;
};

const documentVersionHash = document => sha256(JSON.stringify({
  contentHash: document.contentHash || sha256(document.content),
  parserVersion: document.parserVersion || 'unknown',
  extractionContentHash: document.extractionContentHash || sha256(document.content),
  length: document.content.length,
}));

export class SparseDocumentIndex {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        rowid INTEGER PRIMARY KEY,
        span_id TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL,
        document_name TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        parent_id TEXT NOT NULL,
        page INTEGER,
        breadcrumb TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rag_chunks_document_idx ON rag_chunks(document_id, chunk_index);
      CREATE INDEX IF NOT EXISTS rag_chunks_parent_idx ON rag_chunks(parent_id, chunk_index);
      CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
        content, breadcrumb, content='rag_chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
        INSERT INTO rag_chunks_fts(rowid, content, breadcrumb) VALUES (new.rowid, new.content, new.breadcrumb);
      END;
      CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
        INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content, breadcrumb) VALUES ('delete', old.rowid, old.content, old.breadcrumb);
      END;
      CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE ON rag_chunks BEGIN
        INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content, breadcrumb) VALUES ('delete', old.rowid, old.content, old.breadcrumb);
        INSERT INTO rag_chunks_fts(rowid, content, breadcrumb) VALUES (new.rowid, new.content, new.breadcrumb);
      END;
    `);
    this.deleteDocumentStatement = this.database.prepare('DELETE FROM rag_chunks WHERE document_id = ?');
    this.insertChunkStatement = this.database.prepare(`
      INSERT INTO rag_chunks (
        span_id, document_id, document_name, version_hash, chunk_index, parent_id, page,
        breadcrumb, tags, content, content_hash, indexed_at
      ) VALUES (
        @spanId, @documentId, @documentName, @versionHash, @chunkIndex, @parentId, @page,
        @breadcrumb, @tags, @content, @contentHash, @indexedAt
      )
    `);
    this.replaceDocument = this.database.transaction((documentId, chunks) => {
      this.deleteDocumentStatement.run(documentId);
      for (const chunk of chunks) this.insertChunkStatement.run(chunk);
    });
  }

  indexedVersion(documentId) {
    return this.database.prepare('SELECT version_hash AS versionHash, COUNT(*) AS chunks FROM rag_chunks WHERE document_id = ? GROUP BY version_hash')
      .get(documentId);
  }

  indexDocument(record, { force = false } = {}) {
    if (!record || typeof record.id !== 'string' || !record.data || typeof record.data.content !== 'string') throw new Error('A stored document with extracted text is required');
    const document = record.data;
    if (!document.content.trim()) throw new Error(`Document ${record.id} contains no indexable text`);
    const versionHash = documentVersionHash(document);
    const current = this.indexedVersion(record.id);
    if (!force && current?.versionHash === versionHash) {
      return { id: record.id, name: document.name, versionHash, chunks: current.chunks, reused: true };
    }
    const sourceChunks = Array.isArray(document.chunks) && document.chunks.length
      ? document.chunks
      : chunkDocument(record.id, document.content);
    const headings = headingBreadcrumbs(document.content);
    const indexedAt = Date.now();
    const tags = JSON.stringify(Array.isArray(document.tags) ? document.tags : []);
    const chunks = sourceChunks.map((chunk, position) => {
      const start = Number.isSafeInteger(chunk.start) ? Math.max(0, chunk.start) : 0;
      const end = Number.isSafeInteger(chunk.end) ? Math.min(document.content.length, chunk.end) : document.content.length;
      const content = typeof chunk.text === 'string' ? chunk.text.trim() : document.content.slice(start, end).trim();
      const contentHash = chunk.textHash || sha256(content);
      const chunkIndex = Number.isSafeInteger(chunk.index) ? chunk.index : position;
      const candidateId = typeof chunk.id === 'string'
        ? chunk.id.startsWith(`${record.id}:`) ? chunk.id : `${record.id}:${chunk.id}`
        : undefined;
      return {
        spanId: candidateId || `${record.id}:span:${chunkIndex}:${contentHash.slice(0, 12)}`,
        documentId: record.id,
        documentName: String(document.name || record.id),
        versionHash,
        chunkIndex,
        parentId: `${record.id}:parent:${Math.floor(chunkIndex / 4)}`,
        page: Number.isSafeInteger(chunk.page) ? chunk.page : null,
        breadcrumb: breadcrumbAt(headings, start),
        tags,
        content,
        contentHash,
        indexedAt,
      };
    }).filter(chunk => chunk.content);
    if (!chunks.length) throw new Error(`Document ${record.id} contains no indexable chunks`);
    this.replaceDocument(record.id, chunks);
    return { id: record.id, name: document.name, versionHash, chunks: chunks.length, reused: false };
  }

  removeDocument(documentId) {
    return { id: documentId, removedChunks: this.deleteDocumentStatement.run(documentId).changes };
  }

  status() {
    const totals = this.database.prepare('SELECT COUNT(*) AS chunks, COUNT(DISTINCT document_id) AS documents FROM rag_chunks').get();
    const documents = this.database.prepare(`
      SELECT document_id AS id, document_name AS name, version_hash AS versionHash,
        COUNT(*) AS chunks, MAX(indexed_at) AS indexedAt
      FROM rag_chunks GROUP BY document_id, document_name, version_hash ORDER BY indexedAt DESC
    `).all();
    return {
      version: 1,
      engine: 'sqlite-fts5-bm25',
      databasePath: this.databasePath,
      documentCount: totals.documents,
      chunkCount: totals.chunks,
      documents,
    };
  }

  searchRows(match, documentIds, candidateLimit) {
    const scope = documentIds.length ? `AND c.document_id IN (${documentIds.map(() => '?').join(', ')})` : '';
    return this.database.prepare(`
      SELECT c.*, bm25(rag_chunks_fts, 1.0, 0.25) AS bm25_score
      FROM rag_chunks_fts JOIN rag_chunks c ON c.rowid = rag_chunks_fts.rowid
      WHERE rag_chunks_fts MATCH ? ${scope}
      ORDER BY bm25_score ASC LIMIT ?
    `).all(match, ...documentIds, candidateLimit);
  }

  retrieve({
    query, documentIds = [], tags = [], limit = 10, contextBudget = 4096, includeNeighbors = true,
    allowCorrectivePass = true,
  } = {}) {
    const tokens = queryTokens(query);
    if (!tokens.length) throw new Error('Retrieval query must contain searchable words');
    if (!Array.isArray(documentIds) || documentIds.some(id => typeof id !== 'string')) throw new Error('documentIds must be an array of ids');
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw new Error('tags must be an array of strings');
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
    const boundedBudget = Math.max(256, Math.min(65_536, Math.floor(Number(contextBudget) || 4096)));
    const candidateLimit = Math.min(250, boundedLimit * 8);
    let rows = this.searchRows(tokens.map(quoteToken).join(' '), documentIds, candidateLimit);
    let correctivePass = false;
    if (allowCorrectivePass && rows.length < Math.min(3, boundedLimit) && tokens.length > 1) {
      correctivePass = true;
      const broader = this.searchRows(tokens.map(quoteToken).join(' OR '), documentIds, candidateLimit);
      const seen = new Set(rows.map(row => row.span_id));
      rows = [...rows, ...broader.filter(row => !seen.has(row.span_id))];
    }
    const normalizedTags = tags.map(tag => tag.toLocaleLowerCase());
    if (normalizedTags.length) rows = rows.filter(row => {
      const rowTags = JSON.parse(row.tags).map(tag => String(tag).toLocaleLowerCase());
      return normalizedTags.every(tag => rowTags.includes(tag));
    });

    const diverse = [];
    const parents = new Set();
    for (const row of rows) {
      if (parents.has(row.parent_id)) continue;
      parents.add(row.parent_id);
      diverse.push(row);
      if (diverse.length >= boundedLimit) break;
    }
    if (diverse.length < boundedLimit) {
      const selected = new Set(diverse.map(row => row.span_id));
      diverse.push(...rows.filter(row => !selected.has(row.span_id)).slice(0, boundedLimit - diverse.length));
    }

    const selectedRows = [];
    let estimatedTokens = 0;
    for (const row of diverse) {
      const rowTokens = Math.ceil(row.content.length / 4);
      if (selectedRows.length && estimatedTokens + rowTokens > boundedBudget) continue;
      selectedRows.push(row);
      estimatedTokens += rowTokens;
    }
    const neighborStatement = this.database.prepare(`
      SELECT span_id AS sourceSpanId, chunk_index AS chunkIndex, page, breadcrumb, content
      FROM rag_chunks WHERE document_id = ? AND chunk_index BETWEEN ? AND ? AND span_id <> ? ORDER BY chunk_index
    `);
    const parentStatement = this.database.prepare('SELECT content FROM rag_chunks WHERE parent_id = ? ORDER BY chunk_index');
    const results = selectedRows.map((row, index) => {
      const neighbors = includeNeighbors
        ? neighborStatement.all(row.document_id, row.chunk_index - 1, row.chunk_index + 1, row.span_id)
        : [];
      return {
        sourceSpanId: row.span_id,
        documentId: row.document_id,
        documentName: row.document_name,
        documentVersionHash: row.version_hash,
        chunkIndex: row.chunk_index,
        parentId: row.parent_id,
        page: row.page ?? undefined,
        breadcrumb: row.breadcrumb || undefined,
        content: row.content,
        excerpt: row.content.slice(0, 480),
        score: Number((1 / (60 + index + 1)).toFixed(6)),
        bm25: Number(row.bm25_score.toFixed(6)),
        neighbors,
        parentContent: parentStatement.all(row.parent_id).map(item => item.content).join('\n\n'),
      };
    });
    const topTokens = new Set(results[0] ? normalizedTokens(`${results[0].breadcrumb || ''} ${results[0].content}`) : []);
    const matchedTermsInTop = tokens.filter(token => topTokens.has(token)).length;
    const confidence = !results.length
      ? 'low'
      : matchedTermsInTop === tokens.length
        ? 'high'
        : matchedTermsInTop >= Math.ceil(tokens.length / 2)
          ? 'medium'
          : 'low';
    return {
      query: String(query),
      method: 'sparse-bm25',
      correctivePass,
      confidence,
      estimatedContextTokens: estimatedTokens,
      results,
      ...(confidence === 'low' ? { refusal: 'Quizzer could not find sufficient indexed evidence for this query.' } : {}),
    };
  }

  hydrateResults(results, { includeNeighbors = true, dropMissing = false } = {}) {
    if (!Array.isArray(results) || results.some(result => typeof result?.sourceSpanId !== 'string')) {
      throw new Error('Retrieval results with stable source span ids are required');
    }
    const rowStatement = this.database.prepare('SELECT * FROM rag_chunks WHERE span_id = ?');
    const neighborStatement = this.database.prepare(`
      SELECT span_id AS sourceSpanId, chunk_index AS chunkIndex, page, breadcrumb, content
      FROM rag_chunks WHERE document_id = ? AND chunk_index BETWEEN ? AND ? AND span_id <> ? ORDER BY chunk_index
    `);
    const parentStatement = this.database.prepare('SELECT content FROM rag_chunks WHERE parent_id = ? ORDER BY chunk_index');
    return results.flatMap(result => {
      const row = rowStatement.get(result.sourceSpanId);
      if (!row) {
        if (dropMissing) return [];
        const content = result.content ?? result.excerpt ?? '';
        return [{
          ...result,
          content,
          excerpt: result.excerpt ?? content.slice(0, 480),
          neighbors: result.neighbors ?? [],
          parentContent: result.parentContent ?? content,
        }];
      }
      const neighbors = includeNeighbors
        ? neighborStatement.all(row.document_id, row.chunk_index - 1, row.chunk_index + 1, row.span_id)
        : [];
      return [{
        ...result,
        sourceSpanId: row.span_id,
        documentId: row.document_id,
        documentName: row.document_name,
        documentVersionHash: row.version_hash,
        chunkIndex: row.chunk_index,
        parentId: row.parent_id,
        page: row.page ?? undefined,
        breadcrumb: row.breadcrumb || undefined,
        content: row.content,
        excerpt: row.content.slice(0, 480),
        neighbors,
        parentContent: parentStatement.all(row.parent_id).map(item => item.content).join('\n\n'),
      }];
    });
  }

  close() {
    this.database.close();
  }
}
