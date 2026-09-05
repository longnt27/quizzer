import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-api-test-'));
const port = 18_787;
const token = 'quizzer-test-token-0123456789abcdef';
const origin = `http://127.0.0.1:${port}`;
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

const authorized = (path, init = {}) => fetch(`${origin}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
});

const waitForServer = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test service did not start');
};

await waitForServer();

test.after(async () => {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
});

test('requires authentication for the versioned API', async () => {
  const response = await fetch(`${origin}/api/v1/health`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'unauthorized');
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

  const sync = await fetch(`${origin}/api/storage/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [
      { collection: 'documents', id: 'doc-1', data: { id: 'doc-1', name: 'Guide.md', createdAt: 1, mimeType: 'text/markdown', size: 10, tags: [], content: 'hello' } },
      { collection: 'generationJobs', id: 'job-1', data: { id: 'job-1', status: 'paused', updatedAt: 1, questions: [] } },
    ] }),
  });
  assert.equal(sync.status, 200);

  const documents = await (await authorized('/api/v1/documents')).json();
  assert.equal(documents.documents[0].name, 'Guide.md');
  assert.equal('content' in documents.documents[0], false);

  const resumed = await authorized('/api/v1/jobs/job-1/resume', { method: 'POST' });
  assert.equal((await resumed.json()).job.status, 'queued');

  const events = await authorized('/api/v1/events');
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  const firstEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstEvent, /event: ready/);
  await reader.cancel();
});
