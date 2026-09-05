import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-api-test-'));
const port = 18_787;
const token = 'quizzer-test-token-0123456789abcdef';
const origin = `http://127.0.0.1:${port}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
let serverStderr = '';
let serverExit;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    QUIZZER_APP_DATA_DIR: directory,
    QUIZZER_DATABASE_PATH: join(directory, 'quizzer.sqlite'),
    QUIZZER_API_TOKEN: token,
    QUIZZER_SERVICE_PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', chunk => { serverStderr += chunk; });
server.once('exit', (code, signal) => { serverExit = { code, signal }; });

const authorized = (path, init = {}) => fetch(`${origin}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
});

const waitForServer = async () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (serverExit) {
      throw new Error(`Test service exited before startup (${JSON.stringify(serverExit)}):\n${serverStderr}`);
    }
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Test service did not start within 10 seconds:\n${serverStderr}`);
};

await waitForServer();

test.after(async () => {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
});

test('requires authentication for every sensitive service endpoint', async () => {
  const response = await fetch(`${origin}/api/v1/health`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'unauthorized');
  const legacyResponse = await fetch(`${origin}/api/system/capabilities`);
  assert.equal(legacyResponse.status, 401);
  assert.equal((await legacyResponse.json()).code, 'unauthorized');
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  assert.equal((await authorized('/api/system/capabilities')).status, 200);
  assert.equal((await authorized('/api/v1/health')).status, 200);
  const contract = await authorized('/api/v1/openapi.yaml');
  assert.equal(contract.status, 200);
  assert.match(contract.headers.get('content-type'), /application\/yaml/);
  assert.match(await contract.text(), /openapi: 3\.1\.0[\s\S]*\/jobs\/\{jobId\}\/resume:/);
});

test('exposes settings schema, precedence, and validated updates', async () => {
  const schema = await (await authorized('/api/v1/settings/schema')).json();
  assert.equal(schema.schema.additionalProperties, false);
  assert.ok(schema.registry.some(item => item.key === 'retrieval.mode'));
  assert.equal(schema.profiles.balanced['generation.concurrency'], 3);

  const updated = await authorized('/api/v1/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { 'hardware.profile': 'balanced', 'generation.concurrency': 4 } }),
  });
  assert.equal(updated.status, 200);
  const settings = await updated.json();
  assert.equal(settings.values['retrieval.mode'], 'hybrid');
  assert.equal(settings.values['generation.concurrency'], 4);

  const rejected = await authorized('/api/v1/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { 'provider.apiKey': 'must-not-persist' } }),
  });
  assert.equal(rejected.status, 400);
});

test('exposes the plugin contract and bounded lifecycle collection', async () => {
  const schema = await (await authorized('/api/v1/plugins/schema')).json();
  assert.equal(schema.schema.properties.protocolVersion.const, 1);
  const collection = await (await authorized('/api/v1/plugins')).json();
  assert.ok(collection.builtIn.some(plugin => plugin.id === 'quizzer.index.fts5'));
  assert.deepEqual(collection.plugins, []);
});

test('stores and streams authenticated content-addressed objects', async () => {
  const source = Buffer.from('source object bytes');
  const digest = sha256(source);
  const uploaded = await authorized(`/api/v1/objects/${digest}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: source,
  });
  assert.equal(uploaded.status, 201);
  assert.deepEqual((await uploaded.json()).object, {
    __quizzerObject: true, algorithm: 'sha256', sha256: digest, size: source.length, type: 'application/octet-stream',
  });

  const inspected = await authorized(`/api/v1/objects/${digest}`, { method: 'HEAD' });
  assert.equal(inspected.status, 200);
  assert.equal(Number(inspected.headers.get('content-length')), source.length);
  const downloaded = await authorized(`/api/v1/objects/${digest}`);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), source);
  const status = await (await authorized('/api/v1/objects/status')).json();
  assert.ok(status.unreferencedCount >= 1);

  const rejected = await authorized(`/api/v1/objects/${'0'.repeat(64)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: source,
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /hash mismatch/);
  const pruned = await authorized('/api/v1/objects/unreferenced?confirm=true&minimumAgeHours=0', { method: 'DELETE' });
  assert.ok((await pruned.json()).removed.some(object => object.sha256 === digest));
  assert.equal((await authorized(`/api/v1/objects/${digest}`)).status, 404);
});

test('provides onboarding, document, job, and event operations', async () => {
  const onboarding = {
    onboardingVersion: 1,
    completedSteps: ['welcome'],
    currentStep: 'hardware',
    skipped: false,
  };
  const savedProfile = await authorized('/api/v1/onboarding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarding }),
  });
  assert.equal(savedProfile.status, 200);
  assert.deepEqual((await savedProfile.json()).profile.onboarding, onboarding);

  const sync = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [
      { collection: 'documents', id: 'doc-1', data: { id: 'doc-1', name: 'Guide.md', createdAt: 1, mimeType: 'text/markdown', size: 10, tags: ['iac'], content: '# Terraform\n\nRemote state locking supports safe team collaboration.', originalFile: { __quizzerBlob: true, type: 'text/markdown', name: 'Guide.md', data: `data:text/markdown;base64,${Buffer.from('# Terraform').toString('base64')}` }, images: [{ id: 'figure-1', name: 'state.png', mimeType: 'image/png', data: Buffer.from('state diagram').toString('base64'), page: 1 }] } },
      { collection: 'generationJobs', id: 'job-1', data: { id: 'job-1', status: 'paused', updatedAt: 1, questions: [] } },
    ] }),
  });
  assert.equal(sync.status, 200);

  const documents = await (await authorized('/api/v1/documents')).json();
  assert.equal(documents.documents[0].name, 'Guide.md');
  assert.equal('content' in documents.documents[0], false);
  const storedDocument = (await (await authorized('/api/v1/documents/doc-1')).json()).document;
  assert.equal(storedDocument.originalFile.__quizzerObject, true);
  assert.equal(JSON.stringify(storedDocument).includes('__quizzerBlob'), false);
  assert.equal(storedDocument.images[0].data, undefined);
  assert.equal(storedDocument.images[0].object.__quizzerObject, true);
  const original = await authorized(`/api/v1/objects/${storedDocument.originalFile.sha256}`);
  assert.equal(await original.text(), '# Terraform');
  const figure = await authorized(`/api/v1/objects/${storedDocument.images[0].object.sha256}`);
  assert.equal(await figure.text(), 'state diagram');

  const indexed = await authorized('/api/v1/index', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentIds: ['doc-1'] }),
  });
  const indexResult = await indexed.json();
  assert.equal(indexResult.status.documentCount, 1);
  assert.match(indexResult.status.databasePath, /indexes[/\\]sparse\.sqlite$/);
  const retrieval = await authorized('/api/v1/retrieval/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'remote state locking', documentIds: ['doc-1'], limit: 3 }),
  });
  const evidence = await retrieval.json();
  assert.equal(evidence.confidence, 'high');
  assert.equal(evidence.results[0].documentId, 'doc-1');
  assert.match(evidence.results[0].sourceSpanId, /^doc-1:span:/);

  const resumed = await authorized('/api/v1/jobs/job-1/resume', { method: 'POST' });
  assert.equal((await resumed.json()).job.status, 'queued');
  const claimed = await authorized('/api/v1/jobs/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: 'api-worker-one', leaseMs: 10_000 }),
  });
  const leasedJob = (await claimed.json()).job;
  assert.equal(leasedJob.id, 'job-1');
  assert.equal(leasedJob.workerId, 'api-worker-one');
  assert.match(leasedJob.leaseId, /^[a-f0-9-]{36}$/);
  const duplicateClaim = await authorized('/api/v1/jobs/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: 'api-worker-two', leaseMs: 10_000 }),
  });
  assert.equal((await duplicateClaim.json()).job, undefined);
  const renewed = await authorized('/api/v1/jobs/job-1/lease', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: 'api-worker-one', leaseId: leasedJob.leaseId, leaseMs: 20_000 }),
  });
  assert.ok((await renewed.json()).job.leaseExpiresAt > leasedJob.leaseExpiresAt);

  const events = await authorized('/api/v1/events');
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  const firstEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstEvent, /event: ready/);
  await reader.cancel();
});

test('creates, lists, and verifies complete service-managed backups', async () => {
  const created = await authorized('/api/v1/backups', { method: 'POST' });
  assert.equal(created.status, 201);
  const backup = (await created.json()).backup;
  assert.match(backup.id, /^backup-/);
  assert.ok(backup.manifest.objects.length >= 2);

  const listed = await (await authorized('/api/v1/backups')).json();
  assert.equal(listed.backups.find(item => item.id === backup.id).manifestValid, true);
  const verified = await authorized(`/api/v1/backups/${backup.id}`);
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).backup.valid, true);
});

test('requires and verifies a backed-up legacy bootstrap session', async () => {
  const rejected = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrap: true, changes: [] }),
  });
  assert.equal(rejected.status, 400);

  const changes = [{
    collection: 'tests', id: 'legacy-api-test',
    data: {
      id: 'legacy-api-test', name: 'Imported from IndexedDB', createdAt: 1, questions: [], attempts: [],
      attachment: { __quizzerBlob: true, type: 'text/plain', data: `data:text/plain;base64,${Buffer.from('legacy attachment').toString('base64')}` },
    },
  }];
  const payloadHash = sha256(JSON.stringify(changes[0]));
  const migration = {
    id: 'migration-api-success-0001',
    expectedRecords: 1,
    expectedHash: sha256(`tests:legacy-api-test:${payloadHash}\n`),
    batch: 1,
    batches: 1,
    complete: true,
  };
  const response = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: 0, bootstrap: true, changes, migration }),
  });
  assert.equal(response.status, 200);
  const migrationResponse = await response.json();
  assert.equal(migrationResponse.migration.status, 'complete');
  const migratedChange = migrationResponse.changes.find(change => change.id === changes[0].id);
  assert.equal(migratedChange.data.attachment.__quizzerObject, true);
  const migrations = await (await authorized('/api/v1/migrations')).json();
  const completed = migrations.migrations.find(item => item.id === migration.id);
  assert.equal(completed.receivedHash, migration.expectedHash);
  assert.ok((await stat(completed.backupPath)).size > 0);
});
