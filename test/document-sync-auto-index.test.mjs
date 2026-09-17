import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-auto-index-test-'));
const token = 'quizzer-auto-index-token-0123456789abcdef';

const embeddingServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/tags') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'bge-m3', model: 'bge-m3', size: 1_000_000 }] }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/embed') {
    response.writeHead(404);
    response.end();
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const payload = JSON.parse(body);
    const embeddings = payload.input.map((text, index) => [text.length + index + 1, 1, 0]);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ embeddings }));
  });
});
await new Promise((resolve, reject) => {
  embeddingServer.once('error', reject);
  embeddingServer.listen(0, '127.0.0.1', resolve);
});
const embeddingAddress = embeddingServer.address();
const ollamaHost = `http://127.0.0.1:${embeddingAddress.port}`;

let origin;
let serverStdout = '';
let serverStderr = '';
let serverExit;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    QUIZZER_APP_DATA_DIR: directory,
    QUIZZER_DATABASE_PATH: join(directory, 'quizzer.sqlite'),
    QUIZZER_API_TOKEN: token,
    QUIZZER_SERVICE_PORT: '0',
    QUIZZER_DISABLE_SERVICE_GENERATION: '1',
    OLLAMA_HOST: ollamaHost,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => {
  serverStdout += chunk;
  const match = /Quizzer service listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serverStdout);
  if (match) origin = match[1];
});
server.stderr.on('data', chunk => { serverStderr += chunk; });
server.once('exit', (code, signal) => { serverExit = { code, signal }; });

const authorized = (path, init = {}) => fetch(`${origin}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
});

const waitForServer = async () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (serverExit) throw new Error(`Service exited before startup (${JSON.stringify(serverExit)}):\n${serverStdout}${serverStderr}`);
    try {
      if (origin && (await fetch(`${origin}/api/health`)).ok) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Service did not start:\n${serverStdout}${serverStderr}`);
};

const waitForIndexedDocument = async documentId => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = await (await authorized('/api/v1/index/status')).json();
    if (status.documents?.some(document => document.id === documentId)
      && status.dense?.status === 'ready'
      && status.dense?.activeChunkCount > 0) return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const status = await (await authorized('/api/v1/index/status')).json();
  throw new Error(`Document ${documentId} was not indexed automatically: ${JSON.stringify(status)}`);
};

await waitForServer();

test.after(async () => {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await new Promise(resolve => embeddingServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

test('syncing a document automatically builds sparse and configured dense indexes', async () => {
  const settingsResponse = await authorized('/api/v1/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: {
      'retrieval.mode': 'hybrid',
      'embeddings.enabled': true,
      'embeddings.provider': 'ollama',
      'embeddings.model': 'bge-m3',
    } }),
  });
  assert.equal(settingsResponse.status, 200);

  const sync = await authorized('/api/storage/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [{
      collection: 'documents',
      id: 'auto-index-doc',
      data: {
        id: 'auto-index-doc',
        name: 'Auto index.md',
        createdAt: 1,
        mimeType: 'text/markdown',
        size: 42,
        tags: ['rag'],
        content: '# Dense retrieval\n\nBGE-M3 should be built when this document reaches the service.',
        contentHash: 'auto-index-content-hash',
        parserVersion: 'utf8-1',
        extractionSchemaVersion: 1,
        extractionContentHash: 'auto-index-extraction-hash',
        chunkingVersion: 'structural-v1',
      },
    }] }),
  });
  assert.equal(sync.status, 200);

  const status = await waitForIndexedDocument('auto-index-doc');
  assert.equal(status.documentCount, 1);
  assert.equal(status.dense.embeddingModel, 'ollama:bge-m3');

  const jobs = await (await authorized('/api/v1/index/jobs')).json();
  const job = jobs.jobs.find(candidate => candidate.documentIds?.includes('auto-index-doc'));
  assert.ok(job, 'document sync should create a resumable index job');
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.completedDocumentIds, ['auto-index-doc']);
});
