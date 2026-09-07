import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { canonicalizeManifest } from '../release/manifest.mjs';
import { ObjectStore } from '../server/object-store.mjs';

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'quizzer-cli-test-'));
const source = join(directory, 'terraform.md');
const pluginSourceDocument = join(directory, 'plugin-source.md');
const backup = join(directory, 'backup');
const pluginDirectory = join(directory, 'test-plugin');
const standaloneExecutable = process.env.QUIZZER_CLI_EXECUTABLE;
const appDataDirectory = join(directory, 'data');
const embeddingServer = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const input = JSON.parse(body).input;
    const embeddings = input.map(text => {
      const normalized = text.toLocaleLowerCase();
      return [normalized.includes('terraform') ? 1 : 0, normalized.includes('state') ? 1 : 0, normalized.includes('provider') ? 1 : 0];
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ embeddings }));
  });
});
await new Promise((resolve, reject) => {
  embeddingServer.once('error', reject);
  embeddingServer.listen(0, '127.0.0.1', resolve);
});
const embeddingAddress = embeddingServer.address();
const environment = {
  ...process.env,
  QUIZZER_APP_DATA_DIR: appDataDirectory,
  QUIZZER_DATABASE_PATH: join(appDataDirectory, 'data', 'quizzer.sqlite'),
  OLLAMA_HOST: `http://127.0.0.1:${embeddingAddress.port}`,
  ...(standaloneExecutable ? { QUIZZER_NODE_RUNTIME: process.execPath } : {}),
};
const invocation = arguments_ => standaloneExecutable
  ? { command: standaloneExecutable, arguments: arguments_ }
  : { command: process.execPath, arguments: ['scripts/quizzer.mjs', ...arguments_] };
const cli = async (...arguments_) => {
  const command = invocation([...arguments_, '--json']);
  const { stdout } = await execute(command.command, command.arguments, {
    cwd: new URL('..', import.meta.url), env: environment,
  });
  return JSON.parse(stdout);
};
const seedStorageRecord = async (collection, id, data) => {
  const sourceCode = `
    const storage = await import('./server/storage.mjs');
    storage.putRecord(${JSON.stringify(collection)}, ${JSON.stringify(id)}, ${JSON.stringify(data)});
  `;
  await execute(process.execPath, ['--input-type=module', '--eval', sourceCode], {
    cwd: new URL('..', import.meta.url), env: environment,
  });
};

test('reports the package version without opening storage', async () => {
  const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const command = invocation(['version']);
  const { stdout } = await execute(command.command, command.arguments, {
    cwd: new URL('..', import.meta.url), env: environment,
  });
  assert.equal(stdout.trim(), packageMetadata.version);
});

test('verifies canonical release metadata and rejects tampering', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest = {
    schemaVersion: 1,
    version: '1.0.0-beta.1',
    channel: 'beta',
    publishedAt: '2026-09-05T00:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    artifacts: [{
      name: 'quizzer-cli-1.0.0-beta.1-linux-x64',
      platform: 'linux', architecture: 'x64', format: 'sea', cli: true,
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1/quizzer-cli-1.0.0-beta.1-linux-x64',
      size: 10, sha256: 'a'.repeat(64), minimumOs: 'Current 64-bit Ubuntu or Fedora',
    }],
  };
  const metadata = canonicalizeManifest(manifest);
  const metadataPath = join(directory, 'release-metadata.json');
  const signaturePath = join(directory, 'release-metadata.sig');
  const publicKeyPath = join(directory, 'release-public.pem');
  await writeFile(metadataPath, metadata);
  await writeFile(signaturePath, sign(null, Buffer.from(metadata), privateKey));
  await writeFile(publicKeyPath, publicKey.export({ format: 'pem', type: 'spki' }));
  const result = await cli('release', 'verify', '--metadata', metadataPath, '--signature', signaturePath, '--public-key', publicKeyPath);
  assert.equal(result.valid, true);
  assert.equal(result.artifacts, 1);
  await writeFile(metadataPath, metadata.replace('beta.1', 'beta.2'));
  await assert.rejects(
    cli('release', 'verify', '--metadata', metadataPath, '--signature', signaturePath, '--public-key', publicKeyPath),
    /Release signature is invalid/,
  );
});

test.before(async () => {
  await writeFile(source, '# Terraform\n\nOnly ask about providers and state.\n');
  await writeFile(pluginSourceDocument, '# Original plugin source\n');
  await mkdir(pluginDirectory);
  const pluginSource = `
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const result = request.method === 'rag.rerank'
    ? { ranking: request.params.candidates.map((candidate, index) => ({ sourceSpanId: candidate.sourceSpanId, score: 1 - index / 10 })).reverse() }
    : request.method === 'document.extract'
      ? { content: '# Plugin extracted\\n\\nDurable extractor output.', parserVersion: 'test-1', images: [{ name: 'diagram.png', mimeType: 'image/png', data: Buffer.from('diagram').toString('base64') }] }
      : request.method === 'document.ocr'
        ? { text: 'diagram labels' }
        : { status: 'ready' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`;
  await writeFile(join(pluginDirectory, 'plugin.mjs'), pluginSource);
  await writeFile(join(pluginDirectory, 'quizzer.plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'dev.quizzer.cli-test',
    name: 'CLI test plugin',
    version: '1.0.0',
    protocolVersion: 1,
    entrypoint: 'plugin.mjs',
    capabilities: ['generator', 'reranker', 'extractor', 'ocr'],
    platforms: [{ os: process.platform, architectures: [process.arch] }],
    resources: { memoryMB: 32, diskMB: 1 },
    configuration: { type: 'object' },
    permissions: { network: [], filesystem: ['scoped-temp', 'document-read'], secrets: [], subprocess: false },
    healthCheck: { method: 'plugin.health', timeoutMs: 1000 },
    files: [{ path: 'plugin.mjs', sha256: createHash('sha256').update(pluginSource).digest('hex') }],
  }));
});
test.after(async () => {
  await new Promise(resolve => embeddingServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

test('edits typed configuration and reports resolved values', async () => {
  const set = await cli('config', 'set', 'hardware.profile', 'balanced');
  assert.equal(set.value, 'balanced');
  await cli('config', 'set', 'generation.concurrency', '4');
  const get = await cli('config', 'get', 'generation.concurrency');
  assert.equal(get.value, 4);
  assert.equal(get.source, 'user');
});

test('imports, deduplicates, indexes, and lists a real document', async () => {
  const first = await cli('documents', 'import', source, '--tags', 'iac,terraform');
  assert.equal(first.imported, true);
  assert.equal(first.document.tags.length, 2);
  assert.equal(first.document.originalFile.__quizzerObject, true);
  assert.equal(first.document.originalFile.sha256, first.document.contentHash);
  assert.equal((await stat(join(environment.QUIZZER_APP_DATA_DIR, 'objects', 'sha256', first.document.contentHash.slice(0, 2), first.document.contentHash))).size, first.document.size);
  const duplicate = await cli('documents', 'import', source);
  assert.equal(duplicate.imported, false);
  assert.equal(duplicate.duplicateOf, first.document.id);
  const indexed = await cli('index', '--all');
  assert.equal(indexed.job.kind, 'index');
  assert.equal(indexed.job.status, 'completed');
  assert.deepEqual(indexed.job.completedDocumentIds, [first.document.id]);
  assert.equal(indexed.indexed[0].id, first.document.id);
  assert.equal(indexed.indexed[0].dense.status, 'ready');
  const jobs = await cli('jobs', 'list');
  assert.ok(jobs.jobs.some(job => job.id === indexed.job.id && job.kind === 'index'));
  const shown = await cli('jobs', 'show', indexed.job.id);
  assert.equal(shown.job.status, 'completed');
  const firstReplay = await cli('index', '--all', '--idempotency-key', 'cli-index-replay-0001');
  const secondReplay = await cli('index', '--all', '--idempotency-key', 'cli-index-replay-0001');
  assert.equal(secondReplay.job.id, firstReplay.job.id);
  assert.equal(secondReplay.job.status, 'completed');

  const interruptedJob = {
    id: 'cli-interrupted-index', kind: 'index', status: 'running', documentIds: [first.document.id],
    remainingDocumentIds: [first.document.id], completedDocumentIds: [], results: [], force: false,
    createdAt: 1, updatedAt: 2, startedAt: 2,
  };
  await seedStorageRecord('indexJobs', interruptedJob.id, interruptedJob);
  const recovered = await cli('resume', interruptedJob.id);
  assert.equal(recovered.job.status, 'completed');
  assert.deepEqual(recovered.job.completedDocumentIds, [first.document.id]);
  assert.ok(recovered.job.recoveredAt > interruptedJob.startedAt);
  assert.ok((await stat(join(environment.QUIZZER_APP_DATA_DIR, 'indexes', 'sparse.sqlite'))).size > 0);
  assert.ok((await readdir(join(environment.QUIZZER_APP_DATA_DIR, 'indexes', 'dense.lance'))).length > 0);
  const listed = await cli('documents', 'list');
  assert.equal(listed.documents.length, 1);
  const retrieval = await cli('retrieve', 'Terraform state', '--document', first.document.id);
  assert.equal(retrieval.method, 'hybrid-rrf');
  assert.equal(retrieval.dense.status, 'ready');
  assert.equal(retrieval.reranking.component, 'builtin');
  assert.equal(retrieval.planningTrace.mode, 'multi-query');
  assert.ok(retrieval.planningTrace.variants.length >= 1);
  assert.equal(retrieval.planningTrace.fallback, false);
  assert.equal(retrieval.results[0].documentId, first.document.id);
  assert.match(retrieval.results[0].sourceSpanId, new RegExp(`^${first.document.id}:span:`));
  const humanRetrievalCommand = invocation(['retrieve', 'Terraform state', '--document', first.document.id]);
  const humanRetrieval = await execute(humanRetrievalCommand.command, humanRetrievalCommand.arguments, {
    cwd: new URL('..', import.meta.url), env: environment,
  });
  assert.match(humanRetrieval.stdout, /Query planning: multi-query · \d+ bounded variant/);
  const reextracted = await cli('documents', 'reextract', first.document.id);
  assert.equal(reextracted.document.parserVersion, 'utf8-1');
  assert.equal(reextracted.document.extractionHistory.length, 1);
  assert.equal(reextracted.document.originalFile.sha256, first.document.contentHash);
  assert.equal(reextracted.job.kind, 'index');
  assert.equal(reextracted.job.status, 'completed');
});

test('queues and controls a durable test generation job', async () => {
  const documents = await cli('documents', 'list');
  await assert.rejects(cli(
    'test', 'create', '--document', documents.documents[0].id, '--provider', 'openai', '--model', 'gpt-5-mini',
  ), /--approve-paid/);
  await assert.rejects(cli(
    'test', 'create', '--document', documents.documents[0].id, '--provider', 'openai', '--model', 'gpt-5-mini',
    '--endpoint', 'https://api.example.com/v1', '--approve-paid',
  ), /require --provider openai-compatible/);
  const paidCreated = await cli(
    'test', 'create', '--document', documents.documents[0].id, '--name', 'Approved remote quiz',
    '--questions', '2', '--provider', 'openai', '--model', 'gpt-5-mini', '--approve-paid',
  );
  assert.equal(paidCreated.job.options.routeChain[0].paid, true);
  assert.equal(paidCreated.job.options.routeChain[0].approved, true);
  const ceilingCreated = await cli(
    'test', 'create', '--document', documents.documents[0].id, '--name', 'Capped remote quiz',
    '--questions', '2', '--provider', 'openai', '--model', 'gpt-5-mini', '--approve-paid', '--cost-ceiling', '$1.25',
  );
  assert.equal(ceilingCreated.job.options.costCeilingMicroUsd, 1_250_000);
  assert.equal((await cli('jobs', 'show', ceilingCreated.job.id)).accounting.summary.finalizedCostMicroUsd, 0);
  assert.equal((await cli('jobs', 'list')).jobs.find(job => job.id === ceilingCreated.job.id).accounting.summary.reservedCostMicroUsd, 0);
  await cli('jobs', 'cancel', ceilingCreated.job.id);
  await cli('jobs', 'cancel', paidCreated.job.id);

  await assert.rejects(cli(
    'test', 'create', '--document', documents.documents[0].id, '--provider', 'openai-compatible', '--model', 'my-model',
  ), /--approve-paid/);
  await assert.rejects(cli(
    'test', 'create', '--document', documents.documents[0].id, '--provider', 'openai-compatible', '--approve-paid',
  ), /--model/);
  await assert.rejects(cli(
    'test', 'create', '--document', documents.documents[0].id, '--provider', 'openai-compatible', '--model', 'my-model', '--approve-paid',
    '--endpoint', 'http://remote.invalid/v1',
  ), /require HTTPS/i);
  const compatCreated = await cli(
    'test', 'create', '--document', documents.documents[0].id, '--name', 'OpenAI compatible quiz',
    '--questions', '2', '--provider', 'openai-compatible', '--model', 'my-custom-model', '--approve-paid',
    '--endpoint', 'http://127.0.0.1:11434/v1',
  );
  assert.equal(compatCreated.job.options.provider, 'openai-compatible');
  assert.equal(compatCreated.job.options.model, 'my-custom-model');
  assert.equal(compatCreated.job.options.routeChain[0].paid, true);
  assert.equal(compatCreated.job.options.routeChain[0].approved, true);
  assert.equal(compatCreated.job.options.resolvedSettings['providers.openai-compatible.endpoint'], 'http://127.0.0.1:11434/v1');
  await cli('jobs', 'cancel', compatCreated.job.id);

  const created = await cli(
    'test', 'create', '--document', documents.documents[0].id, '--name', 'Terraform fundamentals',
    '--questions', '5', '--instruction', 'Coding questions about Terraform only', '--provider', 'codex',
  );
  assert.equal(created.job.status, 'queued');
  assert.equal(created.job.options.questionCount, 5);
  assert.equal(created.job.options.ragProfile.retrieval, 'hybrid');
  assert.equal(created.job.options.customInstruction, 'Coding questions about Terraform only');
  const cancelled = await cli('jobs', 'cancel', created.job.id);
  assert.equal(cancelled.job.status, 'cancelled');
  const resumed = await cli('resume', created.job.id, '--provider', 'claude-agent');
  assert.equal(resumed.job.status, 'queued');
  assert.equal(resumed.job.options.provider, 'claude-agent');
  assert.equal(resumed.job.options.customInstruction, 'Coding questions about Terraform only');
  assert.equal(resumed.job.options.routeChain.length, 2);
  assert.equal(resumed.job.providerAttempts[0].outcome, 'manually-selected');
  assert.equal(resumed.job.providerAttempts[0].accepted, 0);

  await cli('jobs', 'cancel', created.job.id);
  await assert.rejects(cli('resume', created.job.id, '--model', 'gpt-5-mini'), /--model requires --provider/);
  await assert.rejects(
    cli('resume', created.job.id, '--endpoint', 'https://api.example.com/v1'),
    /require --provider openai-compatible/,
  );
  await assert.rejects(cli(
    'resume', created.job.id, '--provider', 'openai', '--model', 'gpt-5-mini',
    '--endpoint', 'https://api.example.com/v1', '--approve-paid',
  ), /require --provider openai-compatible/);
  await assert.rejects(cli(
    'resume', created.job.id, '--provider', 'openai', '--model', 'gpt-5-mini',
  ), /--approve-paid/);
  const paidResume = await cli(
    'resume', created.job.id, '--provider', 'openai', '--model', 'gpt-5-mini', '--approve-paid',
  );
  assert.equal(paidResume.job.options.provider, 'openai');
  assert.equal(paidResume.job.options.routeChain.length, 3);
  assert.equal(paidResume.job.providerAttempts.length, 2);
  assert.equal(paidResume.job.providerAttempts[1].model, 'gpt-5-mini');
  await cli('jobs', 'cancel', created.job.id);

  const legacyJob = {
    id: 'cli-legacy-generation-job', testId: 'cli-legacy-generation-test', name: 'Legacy quiz',
    createdAt: 1, updatedAt: 2, status: 'cancelled', documentIds: [documents.documents[0].id],
    options: { provider: 'codex', questionCount: 1 }, questions: [], rejected: 0, rounds: {},
  };
  await seedStorageRecord('generationJobs', legacyJob.id, legacyJob);
  const legacyResume = await cli(
    'resume', legacyJob.id, '--provider', 'openai-compatible', '--model', 'legacy-custom-model',
    '--endpoint', 'http://127.0.0.1:11434/v1', '--approve-paid',
  );
  assert.equal(legacyResume.job.options.provider, 'openai-compatible');
  assert.deepEqual(legacyResume.job.options.routeChain, [{
    provider: 'openai-compatible', model: 'legacy-custom-model', privacy: 'remote-api', paid: true, approved: true,
  }]);
  assert.equal(legacyResume.job.options.resolvedSettings['providers.openai-compatible.endpoint'], 'http://127.0.0.1:11434/v1');
  assert.equal(legacyResume.job.activeRouteIndex, 0);
  assert.equal(legacyResume.job.providerAttempts[0].routeIndex, 0);
  await cli('jobs', 'cancel', legacyJob.id);
});

test('manages unsigned local plugins only after explicit developer opt-in', async () => {
  await cli('config', 'set', 'plugins.developerMode', 'true');
  const installed = await cli('plugins', 'install', pluginDirectory);
  assert.equal(installed.plugin.id, 'dev.quizzer.cli-test');
  assert.match(installed.plugin.warning, /Unsigned local plugin/);
  const health = (await cli('plugins', 'health', installed.plugin.id)).health;
  assert.equal(health.ok, true, health.error);
  assert.equal((await cli('plugins', 'disable', installed.plugin.id)).plugin.enabled, false);
  assert.equal((await cli('plugins', 'enable', installed.plugin.id)).plugin.enabled, true);
  await cli('config', 'set', 'retrieval.rerankerPlugin', installed.plugin.id);
  const documents = await cli('documents', 'list');
  const reranked = await cli('retrieve', 'Terraform state', '--document', documents.documents[0].id);
  assert.equal(reranked.reranking.status, 'ready');
  assert.equal(reranked.reranking.component, installed.plugin.id);
  await cli('config', 'set', 'retrieval.rerankerPlugin', 'builtin');
  await cli('config', 'set', 'extraction.extractorPlugin', installed.plugin.id);
  await cli('config', 'set', 'extraction.ocrPlugin', installed.plugin.id);
  await cli('config', 'set', 'extraction.ocr', 'true');
  const extracted = await cli('documents', 'import', pluginSourceDocument);
  assert.equal(extracted.document.parserVersion, `plugin:${installed.plugin.id}@1.0.0/test-1`);
  assert.equal(extracted.document.content, '# Plugin extracted\n\nDurable extractor output.');
  assert.equal(extracted.document.images[0].ocrText, 'diagram labels');
  assert.equal(extracted.document.images[0].data, undefined);
  assert.equal(extracted.document.images[0].object.__quizzerObject, true);
  await cli('documents', 'remove', extracted.document.id, '--yes');
  const retainedSourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
  await new ObjectStore(appDataDirectory).garbageCollect(new Set([retainedSourceHash]), { minimumAgeMs: 0 });
  await cli('config', 'set', 'extraction.extractorPlugin', 'builtin');
  await cli('config', 'set', 'extraction.ocrPlugin', 'builtin');
  const removed = await cli('plugins', 'remove', installed.plugin.id, '--yes');
  assert.equal(removed.removed, true);
});

test('creates a consistent backup without copying the service token', async () => {
  const result = await cli('backup', 'create', '--destination', backup);
  assert.equal(result.directory, backup);
  assert.ok((await stat(join(backup, 'quizzer.sqlite'))).size > 0);
  assert.equal(JSON.parse(await readFile(join(backup, 'config.jsonc'), 'utf8'))['hardware.profile'], 'balanced');
  assert.equal(result.manifest.objects.length, 1);
  assert.match(result.manifest.objects[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal((await cli('backup', 'verify', backup)).valid, true);
  const object = result.manifest.objects[0];
  assert.equal((await stat(join(backup, ...object.path.split('/')))).size, object.size);
  await assert.rejects(stat(join(backup, 'service-token')), /ENOENT/);

  const currentDocument = (await cli('documents', 'list')).documents[0];
  await cli('config', 'set', 'hardware.profile', 'lite');
  await cli('documents', 'remove', currentDocument.id, '--yes');
  await rm(join(environment.QUIZZER_APP_DATA_DIR, ...object.path.split('/')));
  const restored = await cli('backup', 'restore', backup, '--yes');
  assert.equal(restored.restored, true);
  assert.equal((await cli('config', 'get', 'hardware.profile')).value, 'balanced');
  assert.equal((await cli('documents', 'list')).documents.length, 1);
  assert.equal((await stat(join(environment.QUIZZER_APP_DATA_DIR, ...object.path.split('/')))).size, object.size);
  await assert.rejects(stat(join(environment.QUIZZER_APP_DATA_DIR, 'indexes', 'sparse.sqlite')), /ENOENT/);
  assert.equal((await cli('backup', 'verify', restored.recoveryDirectory)).valid, true);

  await writeFile(join(backup, ...object.path.split('/')), 'tampered');
  await assert.rejects(cli('backup', 'verify', backup), /Command failed/);
});

test('reports durable legacy migration history', async () => {
  const result = await cli('migrations', 'list');
  assert.deepEqual(result.migrations, []);
});

test('supports plugin registry listing and update CLI commands', async () => {
  const listResult = await cli('plugins', 'list');
  assert.ok(Array.isArray(listResult.plugins));

  const registryResult = await cli('plugins', 'list', '--registry');
  assert.ok(Array.isArray(registryResult.plugins));

  await assert.rejects(cli('plugins', 'install'), /requires a directory or plugin id/);
  await assert.rejects(cli('plugins', 'update'), /requires a plugin id/);
  await assert.rejects(cli('plugins', 'update', 'nonexistent-plugin'), /quizzer\.plugin\.json|ENOENT/);
});
