import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-api-test-'));
const token = 'quizzer-test-token-0123456789abcdef';
let slowEmbeddingStarted;
let slowEmbeddingCancelled;
const embeddingServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/version') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ version: '0.12.0-test' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/api/tags') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'qwen3:4b', model: 'qwen3:4b', size: 2_500_000_000 }] }));
    return;
  }
  if (request.method !== 'POST' || !['/api/embed', '/api/generate'].includes(request.url ?? '')) {
    response.writeHead(404);
    response.end();
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const payload = JSON.parse(body);
    if (request.url === '/api/generate') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const output = payload.format?.required?.includes('passage')
        ? JSON.stringify({ passage: 'Terraform remote state locking coordinates concurrent writers.' })
        : '{"questions":[]}';
      response.end(JSON.stringify({ model: payload.model, response: output, done: true }));
      return;
    }
    const input = payload.input;
    const respond = () => {
      const embeddings = input.map(text => {
        const normalized = text.toLocaleLowerCase();
        return [normalized.includes('terraform') ? 1 : 0, normalized.includes('state') ? 1 : 0, normalized.includes('locking') ? 1 : 0];
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ embeddings }));
    };
    if (input.some(text => text.includes('__slow__'))) {
      slowEmbeddingStarted?.();
      const timer = setTimeout(respond, 5_000);
      response.once('close', () => {
        if (!response.writableEnded) {
          clearTimeout(timer);
          slowEmbeddingCancelled?.();
        }
      });
      return;
    }
    respond();
  });
});
await new Promise((resolve, reject) => {
  embeddingServer.once('error', reject);
  embeddingServer.listen(0, '127.0.0.1', resolve);
});
const embeddingAddress = embeddingServer.address();
const ollamaHost = `http://127.0.0.1:${embeddingAddress.port}`;
let origin;
const sha256 = value => createHash('sha256').update(value).digest('hex');
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
const seedServiceRecord = async (collection, id, data) => {
  const code = `const storage = await import('./server/storage.mjs'); storage.putRecord(${JSON.stringify(collection)}, ${JSON.stringify(id)}, ${JSON.stringify(data)});`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, QUIZZER_DATABASE_PATH: join(directory, 'quizzer.sqlite'), QUIZZER_APP_DATA_DIR: directory },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.once('error', reject); child.once('exit', codeValue => codeValue === 0 ? resolve() : reject(new Error(`seed exited ${codeValue}`)));
  });
};

const waitForServer = async () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (serverExit) {
      throw new Error(`Test service exited before startup (${JSON.stringify(serverExit)}):\n${serverStdout}${serverStderr}`);
    }
    try {
      if (origin && (await fetch(`${origin}/api/health`)).ok) return;
    } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Test service did not start within 10 seconds:\n${serverStdout}${serverStderr}`);
};

const waitForIndexJob = async (id, expectedStatus) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await authorized(`/api/v1/index/jobs/${encodeURIComponent(id)}`);
    const payload = await response.json();
    if (payload.job?.status === expectedStatus) return payload.job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Index job ${id} did not reach ${expectedStatus}`);
};

await waitForServer();

test.after(async () => {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await new Promise(resolve => embeddingServer.close(resolve));
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
  assert.equal((await fetch(`${origin}/api/v1/jobs/job-1/accounting`)).status, 401);
  assert.equal((await fetch(`${origin}/api/v1/jobs/job-1/accounting/recovery`)).status, 401);
  assert.equal((await fetch(`${origin}/api/v1/integrations/llama-cpp/runtime`)).status, 401);
  const capabilities = await (await authorized('/api/v1/capabilities')).json();
  assert.equal(capabilities.providerPolicies.codex.maxConcurrency, 1);
  assert.equal(capabilities.providerPolicies.openai.billing, 'usage-based');
  assert.deepEqual(capabilities.providerPolicies.ollama, { billing: 'local', privacy: 'local', maxConcurrency: 1 });
  assert.deepEqual(capabilities.providerPolicies['llama-cpp'], { billing: 'local', privacy: 'local', maxConcurrency: 1 });
  assert.match(capabilities.providers.join(','), /llama-cpp/);
  const contract = await authorized('/api/v1/openapi.yaml');
  assert.equal(contract.status, 200);
  assert.match(contract.headers.get('content-type'), /application\/yaml/);
  assert.match(await contract.text(), /openapi: 3\.1\.0[\s\S]*\/jobs\/\{jobId\}\/resume:/);
  assert.match(await (await authorized('/api/v1/openapi.yaml')).text(), /accounting\/ceiling/);
  assert.match(await (await authorized('/api/v1/openapi.yaml')).text(), /accounting\/recovery/);
  const openApi = await (await authorized('/api/v1/openapi.yaml')).text();
  assert.match(openApi, /\/settings:\n(?:.|\n)*?\n    patch:\n      operationId: updateSettings/);
  assert.match(openApi, /\/integrations\/llama-cpp\/configure:\n    post:/);
  assert.match(openApi, /\/integrations\/llama-cpp\/runtime\/start:/);
  assert.match(openApi, /GenerationProfile:/);
  assert.match(openApi, /minGroundingScore:/);
  assert.match(openApi, /generationProfile: \{ \$ref: '#\/components\/schemas\/GenerationProfile' \}/);
});

test('reports and invokes local Ollama only after explicit setup confirmation', async () => {
  const integrations = await (await authorized('/api/integrations')).json();
  assert.equal(integrations.ollama.serverReady, true);
  assert.equal(integrations.ollama.models[0].name, 'qwen3:4b');
  assert.equal(integrations['openai-compatible'].available, true);
  assert.equal(integrations['llama-cpp'].configured, true);
  const runtime = await (await authorized('/api/v1/integrations/llama-cpp/runtime')).json();
  assert.equal(runtime.runtime.mode, 'manual');
  const unconfirmedRuntime = await authorized('/api/v1/integrations/llama-cpp/runtime/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executablePath: '/tmp/llama-server', modelPath: '/tmp/model.gguf' }),
  });
  assert.equal(unconfirmedRuntime.status, 400);
  const invalidRuntimeStart = await authorized('/api/v1/integrations/llama-cpp/runtime/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(invalidRuntimeStart.status, 400);

  const unconfirmedInstall = await authorized('/api/integrations/ollama/install', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(unconfirmedInstall.status, 400);
  const unconfirmedPull = await authorized('/api/integrations/ollama/pull', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:4b' }),
  });
  assert.equal(unconfirmedPull.status, 400);

  const unconfirmedConfigure = await authorized('/api/integrations/llama-cpp/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'http://127.0.0.1:8080/v1', model: 'llama-3.2-q4' }),
  });
  assert.equal(unconfirmedConfigure.status, 400);
  const remoteConfigure = await authorized('/api/integrations/llama-cpp/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://remote.example.test/v1', model: 'llama-3.2-q4', confirmed: true }),
  });
  assert.equal(remoteConfigure.status, 400);
  const configured = await authorized('/api/integrations/llama-cpp/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'http://127.0.0.1:8080/v1', model: 'llama-3.2-q4', confirmed: true }),
  });
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).settings.values['providers.llama-cpp.model'], 'llama-3.2-q4');

  const generated = await authorized('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', model: 'qwen3:4b', prompt: 'Create a question', schema: { type: 'object' } }),
  });
  assert.equal(generated.status, 200);
  assert.deepEqual(await generated.json(), { output: '{"questions":[]}' });
});

test('exposes settings schema, precedence, and validated updates', async () => {
  const schema = await (await authorized('/api/v1/settings/schema')).json();
  assert.equal(schema.schema.additionalProperties, false);
  assert.ok(schema.registry.some(item => item.key === 'retrieval.mode'));
  assert.ok(schema.registry.some(item => item.key === 'retrieval.planning'));
  assert.ok(schema.registry.some(item => item.key === 'embeddings.model'));
  assert.ok(schema.registry.some(item => item.key === 'embeddings.embedderPlugin'));
  assert.ok(schema.registry.some(item => item.key === 'retrieval.rerankerPlugin'));
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

test('accepts volatile provider credentials without exposing their values', async () => {
  const stored = await authorized('/api/v1/provider-credentials', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { openai: 'service-secret', gemini: 'another-secret', 'openai-compatible': 'compat-secret' } }),
  });
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), { providers: ['gemini', 'openai', 'openai-compatible'] });

  const status = await authorized('/api/v1/provider-credentials');
  const serialized = JSON.stringify(await status.json());
  assert.equal(serialized, '{"providers":["gemini","openai","openai-compatible"]}');
  assert.equal(serialized.includes('service-secret'), false);
  assert.equal(serialized.includes('compat-secret'), false);

  const rejected = await authorized('/api/v1/provider-credentials', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { codex: 'must-not-be-accepted' } }),
  });
  assert.equal(rejected.status, 400);
});

test('exposes the plugin contract and bounded lifecycle collection', async () => {
  const schema = await (await authorized('/api/v1/plugins/schema')).json();
  assert.equal(schema.schema.properties.protocolVersion.const, 1);
  const collection = await (await authorized('/api/v1/plugins')).json();
  assert.ok(collection.builtIn.some(plugin => plugin.id === 'quizzer.index.fts5'));
  assert.deepEqual(collection.plugins, []);

  // Registry endpoints
  const registryDirect = await (await authorized('/api/v1/plugins/registry')).json();
  assert.ok(Array.isArray(registryDirect.plugins));

  const registryParam = await (await authorized('/api/v1/plugins?registry=true')).json();
  assert.ok(Array.isArray(registryParam.plugins));

  // Invalid install payload
  const badInstall = await authorized('/api/v1/plugins/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(badInstall.status, 400);

  for (const body of [
    { path: '/tmp/plugin', confirmed: true },
    { id: 'registry-plugin', confirmed: true },
    { id: 'registry-plugin', confirmationToken: '0'.repeat(64) },
    { id: 'Invalid_Plugin' },
    { path: `bad\0path` },
    { id: 'registry-plugin', unexpected: true },
  ]) {
    const response = await authorized('/api/v1/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  // Non-existent plugin update/rollback returns 400
  const badUpdate = await authorized('/api/v1/plugins/nonexistent/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(badUpdate.status, 400);
  for (const body of [
    { confirmed: true },
    { confirmed: false, confirmationToken: '0'.repeat(64) },
    { confirmed: 'true' },
    { unexpected: true },
  ]) {
    const response = await authorized('/api/v1/plugins/nonexistent/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  const badRollback = await authorized('/api/v1/plugins/nonexistent/rollback', {
    method: 'POST',
  });
  assert.equal(badRollback.status, 400);
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

  const rejectedOnboarding = await authorized('/api/v1/onboarding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onboarding: { ...onboarding, generationJobId: 'job-without-test' } }),
  });
  assert.equal(rejectedOnboarding.status, 400);
  assert.match((await rejectedOnboarding.json()).error, /recorded together/);

  const sync = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [
      { collection: 'documents', id: 'doc-1', data: { id: 'doc-1', name: 'Guide.md', createdAt: 1, mimeType: 'text/markdown', size: 10, tags: ['iac'], content: '# Terraform\n\nRemote state locking supports safe team collaboration.', originalFile: { __quizzerBlob: true, type: 'text/markdown', name: 'Guide.md', data: `data:text/markdown;base64,${Buffer.from('# Terraform').toString('base64')}` }, images: [{ id: 'figure-1', name: 'state.png', mimeType: 'image/png', data: Buffer.from('state diagram').toString('base64'), page: 1 }] } },
    ] }),
  });
  assert.equal(sync.status, 200);

  const creationSettings = await (await authorized('/api/v1/settings')).json();
  const generationOptions = {
    provider: 'gemini', model: 'gemini-2.5-flash', questionCount: 1,
    questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 },
    multipleChoiceMode: 'single', coverageStrategy: 'balanced',
    ragProfile: { id: 'balanced', retrieval: 'hybrid', contextBudget: 4_096, rerank: false, override: true },
    generationProfile: {
      difficulty: 'advanced', batchSize: 20,
      validation: { maxRounds: 3, minGroundingScore: 0.65, minInstructionMatches: 1 },
    },
    routeChain: [{ provider: 'gemini', model: 'gemini-2.5-flash', privacy: 'remote-api', paid: true, approved: true }],
    resolvedSettings: creationSettings.values,
  };
  const createdJobs = await authorized('/api/v1/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobs: [{
      id: 'job-1', testId: 'generated-test-1', name: 'Generated test', status: 'queued', createdAt: 1, updatedAt: 1,
      documentIds: ['doc-1'], options: generationOptions, questions: [], rejected: 0, rounds: {},
    }] }),
  });
  assert.equal(createdJobs.status, 201);
  const createdJob = (await createdJobs.json()).jobs[0];
  assert.equal(createdJob.id, 'job-1');
  assert.deepEqual(createdJob.options.generationProfile, generationOptions.generationProfile);
  assert.equal(createdJob.options.ragProfile.override, true);
  const forgedSync = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [{
      collection: 'generationJobs', id: 'job-1', data: { id: 'job-1', status: 'completed' },
    }] }),
  });
  assert.equal(forgedSync.status, 400);
  const forgedRecoveryMarker = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [{ collection: 'generationJobs', id: 'job-1', data: { id: 'job-1', recoveryAttemptId: 'attempt-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }] }),
  });
  assert.equal(forgedRecoveryMarker.status, 400);

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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentIds: ['doc-1'], idempotencyKey: 'api-index-doc-1' }),
  });
  const indexResult = await indexed.json();
  assert.equal(indexResult.job.status, 'completed');
  assert.deepEqual(indexResult.job.completedDocumentIds, ['doc-1']);
  assert.equal(indexResult.status.documentCount, 1);
  assert.match(indexResult.status.databasePath, /indexes[/\\]sparse\.sqlite$/);
  assert.equal(indexResult.status.dense.status, 'ready');
  assert.equal(indexResult.status.dense.embeddingModel, 'all-minilm');
  assert.equal(indexResult.status.dense.chunkCount, 1);
  const repeatedIndex = await authorized('/api/v1/index', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentIds: ['doc-1'], idempotencyKey: 'api-index-doc-1' }),
  });
  const repeatedIndexResult = await repeatedIndex.json();
  assert.equal(repeatedIndexResult.job.id, indexResult.job.id);
  assert.equal(repeatedIndexResult.job.revision, indexResult.job.revision);
  assert.equal((await authorized(`/api/v1/index/jobs/${indexResult.job.id}/cancel`, { method: 'POST' })).status, 400);
  const listedIndexJobs = await (await authorized('/api/v1/index/jobs')).json();
  assert.ok(listedIndexJobs.jobs.some(job => job.id === indexResult.job.id));
  const retrieval = await authorized('/api/v1/retrieval/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'remote state locking', documentIds: ['doc-1'], limit: 3 }),
  });
  const evidence = await retrieval.json();
  assert.equal(evidence.confidence, 'high');
  assert.equal(evidence.method, 'hybrid-rrf');
  assert.equal(evidence.dense.status, 'ready');
  assert.equal(evidence.reranking.component, 'builtin');
  assert.equal(evidence.reranking.diversity, 'maximal-marginal-relevance');
  assert.equal(evidence.planningTrace.mode, 'multi-query');
  assert.ok(evidence.planningTrace.variants.length >= 1);
  assert.equal(evidence.planningTrace.fallback, false);
  assert.equal(evidence.results[0].documentId, 'doc-1');
  assert.match(evidence.results[0].sourceSpanId, /^doc-1:span:/);
  assert.deepEqual(evidence.results[0].retrievalChannels, ['sparse', 'dense']);

  const hydeSettingsResponse = await authorized('/api/v1/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { 'retrieval.planning': 'hyde', 'retrieval.hydeModel': 'qwen3:4b' } }),
  });
  assert.equal(hydeSettingsResponse.status, 200);
  const hydeResponse = await authorized('/api/v1/retrieval/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'remote state locking', documentIds: ['doc-1'], limit: 3 }),
  });
  const hydeEvidence = await hydeResponse.json();
  assert.equal(hydeEvidence.planningTrace.mode, 'hyde');
  assert.equal(hydeEvidence.planningTrace.hyde, true);
  assert.equal(hydeEvidence.planningTrace.fallback, false);
  assert.ok(hydeEvidence.planningTrace.variants.includes('Terraform remote state locking coordinates concurrent writers.'));

  const reextractedResponse = await authorized('/api/v1/documents/doc-1/reextract', { method: 'POST' });
  assert.equal(reextractedResponse.status, 200);
  const reextracted = await reextractedResponse.json();
  assert.equal(reextracted.document.content, '# Terraform');
  assert.equal(reextracted.document.parserVersion, 'utf8-1');
  assert.equal(reextracted.document.extractionSchemaVersion, 1);
  assert.equal(reextracted.document.extractionHistory.length, 1);
  assert.equal(reextracted.document.images, undefined);
  assert.equal(reextracted.job.status, 'completed');
  assert.equal(reextracted.job.force, true);

  const rewritten = await authorized('/api/v1/jobs/job-1/resume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      options: { ...generationOptions, customInstruction: 'Rewrite the original generation contract.' },
      activeRouteIndex: 0,
    }),
  });
  assert.equal(rewritten.status, 400);
  assert.match((await rewritten.json()).error, /customInstruction cannot change/);
  const continuedOptions = {
    ...generationOptions, provider: 'codex', model: undefined,
    routeChain: [
      ...generationOptions.routeChain,
      { provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true },
    ],
  };
  const resumed = await authorized('/api/v1/jobs/job-1/resume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      options: continuedOptions,
      activeRouteIndex: 1,
      providerAttempts: [{ provider: 'codex', routeIndex: 1, at: 2, accepted: 0, outcome: 'manually-selected' }],
      resetRounds: true,
    }),
  });
  assert.equal(resumed.status, 200);
  const resumedJob = (await resumed.json()).job;
  assert.equal(resumedJob.status, 'queued');
  assert.equal(resumedJob.options.provider, 'codex');
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
  const checkpointed = await authorized('/api/v1/jobs/job-1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: 'api-worker-one', leaseId: leasedJob.leaseId, patch: { rejected: 1, rounds: { reasoning: 1 } } }),
  });
  assert.equal((await checkpointed.json()).job.rejected, 1);
  const staleCheckpoint = await authorized('/api/v1/jobs/job-1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: 'api-worker-two', leaseId: leasedJob.leaseId, patch: { rejected: 99 } }),
  });
  assert.equal(staleCheckpoint.status, 400);
  const completionBody = {
    workerId: 'api-worker-one', leaseId: leasedJob.leaseId, completionId: 'api-completion-one',
    test: { id: 'generated-test-1', name: 'Generated test', createdAt: Date.now(), questions: [{
      type: 'multiple-choice', statement: 'What does remote state locking protect?',
      answer: [
        { content: 'Concurrent state mutation', correct: true, explanation: 'It serializes writers so state changes cannot overwrite one another.' },
        { content: 'Provider authentication', correct: false, explanation: 'Authentication controls access but does not serialize state mutation.' },
        { content: 'Source-code formatting', correct: false, explanation: 'Formatting is unrelated to coordination around shared remote state.' },
      ],
      provenance: { documentIds: ['doc-1'], sourceSpanIds: ['doc-1:span:state-locking'], provider: 'codex' },
    }], attempts: [] },
    patch: { questions: [{
      type: 'multiple-choice', statement: 'What does remote state locking protect?',
      answer: [
        { content: 'Concurrent state mutation', correct: true, explanation: 'It serializes writers so state changes cannot overwrite one another.' },
        { content: 'Provider authentication', correct: false, explanation: 'Authentication controls access but does not serialize state mutation.' },
        { content: 'Source-code formatting', correct: false, explanation: 'Formatting is unrelated to coordination around shared remote state.' },
      ],
      provenance: { documentIds: ['doc-1'], sourceSpanIds: ['doc-1:span:state-locking'], provider: 'codex' },
    }], rejected: 1 },
  };
  const completed = await authorized('/api/v1/jobs/job-1/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(completionBody),
  });
  const completedPayload = await completed.json();
  assert.equal(completedPayload.job.status, 'completed');
  assert.equal(completedPayload.test.id, 'generated-test-1');
  const repeatedCompletion = await authorized('/api/v1/jobs/job-1/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(completionBody),
  });
  assert.equal((await repeatedCompletion.json()).job.revision, completedPayload.job.revision);
  assert.equal((await authorized('/api/v1/jobs/job-1/cancel', { method: 'POST' })).status, 400);

  const recoveryAttemptId = `attempt-${'d'.repeat(48)}`;
  const recoveryFingerprint = sha256(JSON.stringify({ routeIndex: 0, bounds: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, reservationCostMicroUsd: 1, reservationCostKnown: true }));
  await seedServiceRecord('generationJobs', 'api-recovery-job', {
    id: 'api-recovery-job', testId: 'api-recovery-test', name: 'API recovery', status: 'paused', errorCode: 'cost_recovery', recoveryAttemptId,
    documentIds: ['doc-1'], options: { provider: 'codex', questionCount: 1, routeChain: [{ provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true, pricing: { inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1 } }] },
    questions: [], rejected: 0, rounds: {}, usageSummary: { inputTokens: 0, outputTokens: 0, totalTokens: 0, finalizedCostMicroUsd: 0, reservedCostMicroUsd: 1 },
    usageAudit: [{ event: 'reserved', attemptId: recoveryAttemptId, at: 1, routeIndex: 0, provider: 'codex', reservedCostMicroUsd: 1, reservationInputTokens: 1, reservationOutputTokens: 0, reservationCostKnown: true, reservationFingerprint: recoveryFingerprint }],
  });
  const recoveryPath = '/api/v1/jobs/api-recovery-job/accounting/recovery';
  assert.equal((await authorized(recoveryPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Missing confirmation', confirmed: false }) })).status, 400);
  const recoveryApproved = await authorized(recoveryPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Acknowledge possible duplicate billing', confirmed: true }) });
  assert.equal(recoveryApproved.status, 200);
  assert.equal((await recoveryApproved.json()).accounting.audit.at(-1).event, 'recovery-approved');
  const recoveryRepeat = await authorized(recoveryPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Acknowledge possible duplicate billing', confirmed: true }) });
  assert.equal((await recoveryRepeat.json()).accounting.audit.filter(item => item.event === 'recovery-approved').length, 1);

  const cappedJob = {
    id: 'cost-api-job', testId: 'cost-api-test', name: 'Cost API test', status: 'queued', createdAt: 3, updatedAt: 3,
    documentIds: ['doc-1'], options: { ...generationOptions, provider: 'codex', model: undefined, costCeilingMicroUsd: 1_000_000,
      routeChain: [{ ...generationOptions.routeChain[0], provider: 'codex', model: undefined, privacy: 'signed-in-agent', paid: false,
        pricing: { inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 1_000_000 } }] },
    questions: [], rejected: 0, rounds: {},
  };
  const cappedCreate = await authorized('/api/v1/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs: [cappedJob] }),
  });
  assert.equal(cappedCreate.status, 201);
  const cappedClaim = await authorized('/api/v1/jobs/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: 'cost-api-worker', leaseMs: 10_000 }),
  });
  const cappedLeased = (await cappedClaim.json()).job;
  const paused = await authorized('/api/v1/jobs/cost-api-job', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: 'cost-api-worker', leaseId: cappedLeased.leaseId, patch: { status: 'paused', errorCode: 'cost_ceiling' } }),
  });
  assert.equal(paused.status, 200);
  const directResume = await authorized('/api/v1/jobs/cost-api-job/resume', { method: 'POST' });
  assert.equal(directResume.status, 400);
  assert.match((await directResume.json()).error, /one matching unmatched ceiling raise/);
  assert.equal((await fetch(`${origin}/api/v1/jobs/cost-api-job/accounting`)).status, 401);
  const accounting = await authorized('/api/v1/jobs/cost-api-job/accounting');
  assert.equal(accounting.status, 200);
  assert.equal((await accounting.json()).accounting.summary.finalizedCostMicroUsd, 0);
  assert.equal((await authorized('/api/v1/jobs/missing-cost-job/accounting')).status, 404);
  const zeroRaise = await authorized('/api/v1/jobs/cost-api-job/accounting/ceiling', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newCeilingMicroUsd: 0, reason: 'Invalid', confirmed: true }),
  });
  assert.equal(zeroRaise.status, 400);
  const decreasingRaise = await authorized('/api/v1/jobs/cost-api-job/accounting/ceiling', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newCeilingMicroUsd: 999_999, reason: 'Invalid', confirmed: true }),
  });
  assert.equal(decreasingRaise.status, 400);
  const unconfirmed = await authorized('/api/v1/jobs/cost-api-job/accounting/ceiling', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newCeilingMicroUsd: 2_000_000, reason: 'Need more coverage', confirmed: false }),
  });
  assert.equal(unconfirmed.status, 400);
  const raised = await authorized('/api/v1/jobs/cost-api-job/accounting/ceiling', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newCeilingMicroUsd: 2_000_000, reason: 'Need more coverage', confirmed: true }),
  });
  assert.equal(raised.status, 200);
  const raisedPayload = await raised.json();
  assert.equal(raisedPayload.accounting.audit.at(-1).event, 'ceiling-raised');
  const resumedAfterRaise = await authorized('/api/v1/jobs/cost-api-job/resume', { method: 'POST' });
  assert.equal(resumedAfterRaise.status, 200);
  const resumedPayload = await resumedAfterRaise.json();
  assert.equal(resumedPayload.job.status, 'queued');
  const resumedAccounting = await authorized('/api/v1/jobs/cost-api-job/accounting');
  const resumedAccountingPayload = await resumedAccounting.json();
  assert.equal(resumedAccountingPayload.accounting.audit.at(-1).event, 'ceiling-resumed');
  assert.equal(resumedAccountingPayload.accounting.audit.at(-1).currentCeilingMicroUsd, 2_000_000);

  const events = await authorized('/api/v1/events');
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  const firstEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstEvent, /event: ready/);
  await reader.cancel();
});

test('persists failed asynchronous indexing and resumes from its checkpoint', async () => {
  const created = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [{
      collection: 'documents', id: 'repair-doc',
      data: { id: 'repair-doc', name: 'Repair.md', createdAt: 2, mimeType: 'text/markdown', size: 0, tags: [], content: '' },
    }] }),
  });
  assert.equal(created.status, 200);
  const started = await authorized('/api/v1/index', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentIds: ['repair-doc'], wait: false, idempotencyKey: 'repair-index-0001' }),
  });
  assert.equal(started.status, 202);
  const startedJob = (await started.json()).job;
  const failed = await waitForIndexJob(startedJob.id, 'failed');
  assert.match(failed.error, /no indexable text/);
  assert.deepEqual(failed.remainingDocumentIds, ['repair-doc']);

  const repaired = await authorized('/api/storage/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [{
      collection: 'documents', id: 'repair-doc',
      data: { id: 'repair-doc', name: 'Repair.md', createdAt: 2, mimeType: 'text/markdown', size: 20, tags: [], content: '# Repaired\n\nDurable indexing resumes safely.' },
    }] }),
  });
  assert.equal(repaired.status, 200);
  const resumed = await authorized(`/api/v1/index/jobs/${startedJob.id}/resume`, { method: 'POST' });
  assert.equal(resumed.status, 202);
  const completed = await waitForIndexJob(startedJob.id, 'completed');
  assert.deepEqual(completed.completedDocumentIds, ['repair-doc']);
  assert.deepEqual(completed.remainingDocumentIds, []);
});

test('cancels dense retrieval when its HTTP client disconnects', async () => {
  const started = new Promise(resolve => { slowEmbeddingStarted = resolve; });
  const cancelled = new Promise(resolve => { slowEmbeddingCancelled = resolve; });
  const controller = new AbortController();
  const pending = authorized('/api/v1/retrieval/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
    body: JSON.stringify({ query: '__slow__ terraform', documentIds: ['doc-1'] }),
  });
  await started;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await Promise.race([
    cancelled,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Embedding request was not cancelled')), 1_000)),
  ]);
  assert.equal((await authorized('/api/v1/health')).status, 200);
  slowEmbeddingStarted = undefined;
  slowEmbeddingCancelled = undefined;
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
