import { readFile, writeFile } from 'node:fs/promises';

const replaceOrThrow = (source, before, after, label) => {
  if (!source.includes(before)) throw new Error(`Could not find ${label}`);
  if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Found multiple ${label} matches`);
  return source.replace(before, after);
};

let server = await readFile('server.mjs', 'utf8');

server = replaceOrThrow(server, `const retrievalDocumentFingerprint = record => createHash('sha256').update(JSON.stringify({
  id: record.id,
  contentHash: record.data.contentHash || createHash('sha256').update(record.data.content).digest('hex'),
  parserVersion: record.data.parserVersion || 'unknown',
  extractionContentHash: record.data.extractionContentHash || createHash('sha256').update(record.data.content).digest('hex'),
  length: record.data.content.length,
})).digest('hex');

setImmediate(() => {
  for (const record of listRecords('indexJobs')) {
    if (record.data.status !== 'queued' && record.data.status !== 'running') continue;
    try {
      const recovered = recoverIndexJob(record.data);
      if (recovered !== record.data) saveIndexJob(recovered);
      void executeIndexJob(record.id).catch(error => reportIndexFailure(record.id, error));
    } catch (error) {
      reportIndexFailure(record.id, error);
    }
  }
});`, `const retrievalDocumentFingerprint = record => createHash('sha256').update(JSON.stringify({
  id: record.id,
  contentHash: record.data.contentHash || createHash('sha256').update(record.data.content).digest('hex'),
  parserVersion: record.data.parserVersion || 'unknown',
  extractionContentHash: record.data.extractionContentHash || createHash('sha256').update(record.data.content).digest('hex'),
  length: record.data.content.length,
})).digest('hex');

const automaticIndexFingerprint = record => createHash('sha256').update(JSON.stringify({
  document: retrievalDocumentFingerprint(record),
  tags: Array.isArray(record.data.tags) ? record.data.tags : [],
  chunkingVersion: record.data.chunkingVersion,
})).digest('hex');
const pendingAutomaticIndexDocumentIds = new Set();
let automaticIndexTimer;
const queueAutomaticIndexing = documentIds => {
  for (const id of documentIds ?? []) if (typeof id === 'string' && id) pendingAutomaticIndexDocumentIds.add(id);
  if (!pendingAutomaticIndexDocumentIds.size || automaticIndexTimer) return;
  automaticIndexTimer = setTimeout(() => {
    automaticIndexTimer = undefined;
    const ids = [...pendingAutomaticIndexDocumentIds].sort();
    pendingAutomaticIndexDocumentIds.clear();
    void (async () => {
      const records = ids.map(id => getRecord('documents', id)).filter(Boolean).sort((left, right) => left.id.localeCompare(right.id));
      if (!records.length) return;
      const configuration = await retrievalIndex.configuration();
      const indexConfiguration = JSON.stringify({
        embeddings: configuration.embeddings,
        embeddingModel: configuration.embeddingModel,
        vectorIndex: configuration.vectorIndex.identity,
      });
      const idempotencyKey = 'automatic.' + createHash('sha256')
        .update(records.map(automaticIndexFingerprint).join('|') + '|' + indexConfiguration).digest('hex');
      const job = prepareIndexJob({ records, idempotencyKey });
      if (job.data.status !== 'completed') await executeIndexJob(job.id);
    })().catch(error => reportIndexFailure('automatic', error));
  }, 0);
};

setImmediate(() => {
  for (const record of listRecords('indexJobs')) {
    if (record.data.status !== 'queued' && record.data.status !== 'running') continue;
    try {
      const recovered = recoverIndexJob(record.data);
      if (recovered !== record.data) saveIndexJob(recovered);
      void executeIndexJob(record.id).catch(error => reportIndexFailure(record.id, error));
    } catch (error) {
      reportIndexFailure(record.id, error);
    }
  }
  queueAutomaticIndexing(listRecords('documents').map(record => record.id));
});`, 'automatic index coordinator');

server = replaceOrThrow(server, `    if (request.method === 'PATCH' && url.pathname === '/api/v1/settings') {
      await updateUserSettings(await readJson(request));
      send(response, 200, await loadResolvedSettings(appDataDirectory));
      return true;
    }`, `    if (request.method === 'PATCH' && url.pathname === '/api/v1/settings') {
      await updateUserSettings(await readJson(request));
      const settings = await loadResolvedSettings(appDataDirectory);
      queueAutomaticIndexing(listRecords('documents').map(record => record.id));
      send(response, 200, settings);
      return true;
    }`, 'settings indexing hook');

server = replaceOrThrow(server, `    integrationJobs.embeddings = { state: 'complete', message: \`${'${modelName}'} is installed and dense retrieval is ready.\` };`, `    integrationJobs.embeddings = { state: 'complete', message: \`${'${modelName}'} is installed and dense retrieval is ready.\` };
    queueAutomaticIndexing(listRecords('documents').map(record => record.id));`, 'embedding install indexing hook');

server = replaceOrThrow(server, `      for (const change of body?.changes ?? []) {
        if (change.collection === 'documents' && change.deleted === true && typeof change.id === 'string') await retrievalIndex.removeDocument(change.id);
      }
      return send(response, 200, result);`, `      for (const change of changes) {
        if (change.collection === 'documents' && change.deleted === true && typeof change.id === 'string') await retrievalIndex.removeDocument(change.id);
      }
      queueAutomaticIndexing(changes
        .filter(change => change.collection === 'documents' && change.deleted !== true)
        .map(change => change.id));
      return send(response, 200, result);`, 'storage sync indexing hook');

await writeFile('server.mjs', server);

let documentView = await readFile('src/components/DocumentView.tsx', 'utf8');
documentView = replaceOrThrow(documentView, `        message={indexStatus.dense.status === 'ready'
          ? \`Dense retrieval ready · ${'${indexStatus.dense.embeddingModel}'}\`
          : indexStatus.dense.status === 'unavailable' ? \`Dense retrieval unavailable · ${'${indexStatus.dense.embeddingModel}'}\` : 'Dense retrieval will be built during indexing'}`, `        message={indexStatus.dense.status === 'ready' && indexed && document.denseIndex?.model === indexStatus.dense.embeddingModel
          ? \`Dense retrieval ready · ${'${indexStatus.dense.embeddingModel}'}\`
          : indexStatus.dense.status === 'unavailable' ? \`Dense retrieval unavailable · ${'${indexStatus.dense.embeddingModel}'}\`
            : indexed ? 'Dense retrieval is being built for this document' : 'Dense retrieval will be built during indexing'}`, 'document dense readiness message');
await writeFile('src/components/DocumentView.tsx', documentView);
