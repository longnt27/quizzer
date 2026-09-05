import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { canonicalizeManifest } from '../release/manifest.mjs';

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'quizzer-cli-test-'));
const source = join(directory, 'terraform.md');
const backup = join(directory, 'backup');
const pluginDirectory = join(directory, 'test-plugin');
const standaloneExecutable = process.env.QUIZZER_CLI_EXECUTABLE;
const environment = {
  ...process.env,
  QUIZZER_APP_DATA_DIR: join(directory, 'data'),
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
  await mkdir(pluginDirectory);
  const pluginSource = `
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status: 'ready' } }) + '\\n');
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
    capabilities: ['generator'],
    platforms: [{ os: process.platform, architectures: [process.arch] }],
    resources: { memoryMB: 32, diskMB: 1 },
    configuration: { type: 'object' },
    permissions: { network: [], filesystem: ['scoped-temp'], secrets: [], subprocess: false },
    healthCheck: { method: 'plugin.health', timeoutMs: 1000 },
    files: [{ path: 'plugin.mjs', sha256: createHash('sha256').update(pluginSource).digest('hex') }],
  }));
});
test.after(async () => rm(directory, { recursive: true, force: true }));

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
  assert.equal(indexed.indexed[0].id, first.document.id);
  const listed = await cli('documents', 'list');
  assert.equal(listed.documents.length, 1);
  const retrieval = await cli('retrieve', 'Terraform state', '--document', first.document.id);
  assert.equal(retrieval.results[0].documentId, first.document.id);
  assert.match(retrieval.results[0].sourceSpanId, new RegExp(`^${first.document.id}:span:`));
});

test('queues and controls a durable test generation job', async () => {
  const documents = await cli('documents', 'list');
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
  const resumed = await cli('resume', created.job.id);
  assert.equal(resumed.job.status, 'queued');
});

test('manages unsigned local plugins only after explicit developer opt-in', async () => {
  await cli('config', 'set', 'plugins.developerMode', 'true');
  const installed = await cli('plugins', 'install', pluginDirectory);
  assert.equal(installed.plugin.id, 'dev.quizzer.cli-test');
  assert.match(installed.plugin.warning, /Unsigned local plugin/);
  assert.equal((await cli('plugins', 'health', installed.plugin.id)).health.ok, true);
  assert.equal((await cli('plugins', 'disable', installed.plugin.id)).plugin.enabled, false);
  assert.equal((await cli('plugins', 'enable', installed.plugin.id)).plugin.enabled, true);
  const removed = await cli('plugins', 'remove', installed.plugin.id, '--yes');
  assert.equal(removed.removed, true);
});

test('creates a consistent backup without copying the service token', async () => {
  const result = await cli('backup', 'create', '--destination', backup);
  assert.equal(result.directory, backup);
  assert.ok((await stat(join(backup, 'quizzer.sqlite'))).size > 0);
  assert.equal(JSON.parse(await readFile(join(backup, 'config.jsonc'), 'utf8'))['hardware.profile'], 'balanced');
  await assert.rejects(stat(join(backup, 'service-token')), /ENOENT/);
});

test('reports durable legacy migration history', async () => {
  const result = await cli('migrations', 'list');
  assert.deepEqual(result.migrations, []);
});
