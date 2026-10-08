import { ensure, fingerprint, projectInput } from './dataset.mjs';
import { verifySourceLock } from './sources.mjs';
import { createRun, PROTOCOL } from './evaluation.mjs';

export async function collectRetrieval(dataset, config, { token, sourceLock, allowCandidate = false,
  acknowledgeProviderAccess = false, fetcher = fetch } = {}) {
  ensure(acknowledgeProviderAccess, 'Explicitly acknowledge provider access: retrieval may invoke embeddings or query-planning models');
  ensure(allowCandidate || dataset.status === 'reviewed', 'Candidate dataset requires --allow-candidate');
  const base = new URL(config.baseUrl);
  ensure(base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)
    && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'Only an HTTP loopback service origin is permitted');
  ensure(typeof token === 'string' && token.length > 0, 'Service token environment variable required');
  ensure(['dev', 'test'].includes(config.split), 'Invalid split');
  verifySourceLock(dataset.sources, sourceLock);
  const tasks = dataset.retrieval.filter(r => r.split === config.split);
  ensure(tasks.length > 0, 'No retrieval tasks');
  const sourceIds = [...new Set(tasks.flatMap(t => t.documentIds))];
  const mapped = sourceIds.map(id => config.documentMap?.[id]);
  ensure(mapped.every(id => typeof id === 'string' && id.length > 0) && new Set(mapped).size === mapped.length, 'Complete unique runtime document mapping required');
  const reverse = new Map(sourceIds.map(id => [config.documentMap[id], id]));
  const request = async (path, body) => {
    const response = await fetcher(`${base.origin}/api/v1${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(120000) });
    ensure(response.ok, `HTTP ${response.status}`);
    return response.json();
  };
  const settings = await request('/settings');
  ensure(settings.values && typeof settings.values === 'object', 'Resolved service settings required');
  const settingsFingerprint = fingerprint(settings.values);
  const extraction = [];
  for (const id of sourceIds) {
    const { document } = await request(`/documents/${encodeURIComponent(config.documentMap[id])}`);
    const pin = sourceLock.sources.find(s => s.id === id);
    ensure(document?.id === config.documentMap[id] && document.originalFile?.sha256 === pin.sha256,
      `Imported document hash mismatch: ${id}`);
    ensure(typeof document.content === 'string' && document.content.length > 0, `Imported document has no text: ${id}`);
    extraction.push({ id, parserVersion: document.parserVersion ?? null,
      extractionFingerprint: fingerprint({ content: document.content, chunks: document.chunks ?? [] }) });
  }
  const run = createRun(dataset, { track: 'retrieval', split: config.split, sourceLock,
    system: { ...config.system, settingsFingerprint } });
  run.extraction = extraction; run.startedAt = new Date().toISOString();
  for (const task of tasks) {
    const input = projectInput(task); const start = performance.now();
    try {
      const result = await request('/retrieval/preview', { query: input.query,
        documentIds: input.documentIds.map(id => config.documentMap[id]),
        limit: PROTOCOL.limit, contextBudget: PROTOCOL.contextBudget, includeNeighbors: PROTOCOL.includeNeighbors });
      ensure(Array.isArray(result.results) && result.results.length <= PROTOCOL.limit
        && ['low', 'medium', 'high'].includes(result.confidence), 'Malformed retrieval response');
      const results = result.results.map(item => {
        const documentId = reverse.get(item.documentId);
        const source = dataset.sources.find(s => s.id === documentId);
        ensure(source && input.documentIds.includes(documentId) && typeof item.sourceSpanId === 'string'
          && item.sourceSpanId.length > 0 && (item.page === undefined || item.page === null
            || Number.isInteger(item.page) && item.page >= 1 && item.page <= source.pages), 'Invalid or unscoped source location');
        return { documentId, sourceSpanId: item.sourceSpanId, page: item.page ?? null };
      });
      run.predictions.push({ id: input.id, status: 'ok',
        refused: result.confidence === 'low' && typeof result.refusal === 'string' && result.refusal.length > 0,
        results, elapsedMs: performance.now() - start,
        method: ['sparse-bm25', 'hybrid-rrf'].includes(result.method) ? result.method : 'unknown',
        denseStatus: ['ready', 'unavailable', 'disabled'].includes(result.dense?.status) ? result.dense.status : null,
        indexingFailed: Boolean(result.indexingError) });
    } catch {
      run.predictions.push({ id: input.id, status: 'error', refused: false, results: [],
        elapsedMs: performance.now() - start, error: 'request-or-response-failed' });
    }
  }
  const after = await request('/settings');
  ensure(fingerprint(after.values) === settingsFingerprint, 'Service settings changed during the run');
  run.completedAt = new Date().toISOString();
  return run;
}
