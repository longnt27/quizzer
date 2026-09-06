import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PluginManager } from '../plugin-sdk/manager.mjs';
import { invokePluginProcess } from '../plugin-sdk/runtime.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-plugin-runtime-test-'));
const appDataDirectory = join(directory, 'data');
const sourceRoot = join(directory, 'sources');
const pluginSource = `
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === 'plugin.wait') await new Promise(resolve => setTimeout(resolve, 5000));
  if (request.method === 'plugin.exit') {
    process.stderr.write('deliberate plugin exit');
    process.exit(7);
  }
  if (request.method === 'plugin.error' || request.method === 'plugin.empty-error') {
    const error = request.method === 'plugin.error' ? { message: 'deliberate plugin error' } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error }) + '\\n');
    continue;
  }
  if (request.method === 'plugin.output-limit') {
    process.stdout.write('x'.repeat(10 * 1024 * 1024 + 1));
    continue;
  }
  if (request.method === 'plugin.noise') {
    process.stdout.write('\\nnot-json\\n' + JSON.stringify({ jsonrpc: '2.0', id: 'wrong-id', result: null }) + '\\n');
  }
  const result = request.method === 'plugin.health'
    ? { status: 'ready', version: process.env.PLUGIN_VERSION }
    : {
        params: request.params,
        configuration: request.context.configuration,
        temporaryDirectory: request.context.temporaryDirectory,
        scopedFiles: request.context.scopedFiles,
        scopedContents: await Promise.all(request.context.scopedFiles.map(file => readFile(join(request.context.temporaryDirectory, file.path), 'utf8'))),
        allowedSecret: process.env.TEST_PLUGIN_KEY,
        hiddenSecret: process.env.UNDECLARED_PLUGIN_KEY,
        retainedPath: Boolean(process.env.PATH),
        hiddenNodeOptions: process.env.NODE_OPTIONS,
      };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`;

const createPlugin = async (version, suffix = '') => {
  const pluginDirectory = join(sourceRoot, `plugin-${version}`);
  await mkdir(pluginDirectory, { recursive: true });
  const source = `${pluginSource}\n// ${suffix}`;
  await writeFile(join(pluginDirectory, 'plugin.mjs'), source);
  const manifest = {
    schemaVersion: 1,
    id: 'dev.quizzer.runtime-test',
    name: 'Runtime test plugin',
    version,
    protocolVersion: 1,
    entrypoint: 'plugin.mjs',
    capabilities: ['generator'],
    platforms: [{ os: process.platform, architectures: [process.arch] }],
    resources: { memoryMB: 32, diskMB: 1, accelerators: ['cpu'] },
    configuration: { type: 'object', additionalProperties: false },
    permissions: { network: [], filesystem: ['scoped-temp'], secrets: ['TEST_PLUGIN_KEY'], subprocess: false },
    healthCheck: { method: 'plugin.health', timeoutMs: 2000 },
    files: [{ path: 'plugin.mjs', sha256: createHash('sha256').update(source).digest('hex') }],
  };
  await writeFile(join(pluginDirectory, 'quizzer.plugin.json'), JSON.stringify(manifest));
  return { pluginDirectory, manifest };
};

test.before(async () => mkdir(sourceRoot, { recursive: true }));
test.after(async () => rm(directory, { recursive: true, force: true }));

test('runs JSON-RPC with scoped files, explicit secrets, limits, and cancellation', async () => {
  const { pluginDirectory, manifest } = await createPlugin('1.0.0', 'direct');
  const invocation = await invokePluginProcess({
    appDataDirectory,
    directory: pluginDirectory,
    manifest,
    method: 'plugin.echo',
    params: { value: 42 },
    configuration: { mode: 'test' },
    secrets: { TEST_PLUGIN_KEY: 'allowed', UNDECLARED_PLUGIN_KEY: 'hidden' },
    files: [{ path: 'sources/context.txt', data: 'bounded source context' }],
  });
  assert.deepEqual(invocation.result.params, { value: 42 });
  assert.deepEqual(invocation.result.configuration, { mode: 'test' });
  assert.equal(invocation.result.allowedSecret, 'allowed');
  assert.equal(invocation.result.hiddenSecret, undefined);
  assert.equal(invocation.result.retainedPath, true);
  assert.equal(invocation.result.hiddenNodeOptions, undefined);
  assert.deepEqual(invocation.result.scopedFiles, [{ path: join('sources', 'context.txt'), size: 22 }]);
  assert.deepEqual(invocation.result.scopedContents, ['bounded source context']);
  await assert.rejects(stat(invocation.result.temporaryDirectory), /ENOENT/);

  const controller = new AbortController();
  const waiting = invokePluginProcess({
    appDataDirectory, directory: pluginDirectory, manifest, method: 'plugin.wait', signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(waiting, error => error.name === 'AbortError');
});

test('isolates malformed plugin responses and bounded process failures', async () => {
  const { pluginDirectory, manifest } = await createPlugin('1.0.1', 'failures');
  const invoke = (method, options = {}) => invokePluginProcess({
    appDataDirectory, directory: pluginDirectory, manifest, method, ...options,
  });

  assert.deepEqual((await invoke('plugin.noise')).result.params, {});
  await assert.rejects(invoke('plugin.error'), /deliberate plugin error/);
  await assert.rejects(invoke('plugin.empty-error'), /Plugin dev\.quizzer\.runtime-test failed/);
  await assert.rejects(invoke('plugin.exit'), /deliberate plugin exit/);
  await assert.rejects(invoke('plugin.wait', { timeoutMs: 30 }), /timed out after 30 ms/);
  await assert.rejects(invoke('plugin.output-limit'), /exceeded the output limit/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(invoke('plugin.echo', { signal: controller.signal }), error => error.name === 'AbortError');

  await assert.rejects(invokePluginProcess({
    appDataDirectory,
    directory: pluginDirectory,
    manifest: { ...manifest, entrypoint: 'missing-plugin-executable' },
    method: 'plugin.echo',
  }), /ENOENT/);
});

test('rejects invalid plugin invocation inputs before spawning', async () => {
  const { pluginDirectory, manifest } = await createPlugin('1.0.2', 'validation');
  const common = { appDataDirectory, directory: pluginDirectory, manifest };
  await assert.rejects(invokePluginProcess({ ...common, method: '' }), /method is required/);
  await assert.rejects(invokePluginProcess({ ...common, method: 'plugin.echo', params: [] }), /parameters must be an object/);
  await assert.rejects(invokePluginProcess({ ...common, method: 'plugin.echo', configuration: null }), /configuration must be an object/);
  await assert.rejects(invokePluginProcess({ ...common, method: 'plugin.echo', files: {} }), /array of at most 30/);
  await assert.rejects(invokePluginProcess({ ...common, method: 'plugin.echo', fileLimits: { maximumFiles: 101 } }), /file limits are invalid/);
  await assert.rejects(invokePluginProcess({
    ...common, method: 'plugin.echo', files: [{ path: 'source.txt', data: 'xx' }],
    fileLimits: { maximumFiles: 1, maximumFileBytes: 1, maximumTotalBytes: 2 },
  }), /exceeds 1 bytes/);
  await assert.rejects(invokePluginProcess({ ...common, method: 'plugin.echo', files: [{ path: '../escape', data: 'x' }] }), /Unsafe plugin path/);
  await assert.rejects(invokePluginProcess({
    ...common, method: 'plugin.echo', files: [{ path: 'source.txt', data: 'x' }],
    manifest: { ...manifest, permissions: { ...manifest.permissions, filesystem: [] } },
  }), /declare scoped-temp permission/);
});

test('installs, blocks, enables, checks, upgrades, rolls back, and removes plugins', async () => {
  const first = await createPlugin('1.0.0', 'first');
  const manager = new PluginManager({ appDataDirectory, developerMode: true });
  const installed = await manager.install(first.pluginDirectory);
  assert.equal(installed.trust, 'unsigned-local');
  assert.equal(installed.enabled, true);
  assert.equal(installed.rollbackAvailable, false);
  assert.match(installed.warning, /Unsigned local plugin/);
  assert.deepEqual(await readdir(join(appDataDirectory, 'plugins', 'staging')), []);

  const lockedManager = new PluginManager({ appDataDirectory, developerMode: false });
  assert.equal((await lockedManager.list())[0].status, 'blocked');
  await assert.rejects(lockedManager.invoke(first.manifest.id, 'plugin.echo'), /Developer Mode/);

  assert.equal((await manager.health(first.manifest.id)).ok, true);
  assert.equal((await manager.setEnabled(first.manifest.id, false)).enabled, false);
  await assert.rejects(manager.invoke(first.manifest.id, 'plugin.echo'), /disabled/);
  await manager.setEnabled(first.manifest.id, true);

  const second = await createPlugin('1.1.0', 'second');
  const upgraded = await manager.install(second.pluginDirectory);
  assert.equal(upgraded.version, '1.1.0');
  assert.equal(upgraded.rollbackAvailable, true);
  assert.deepEqual(await readdir(join(appDataDirectory, 'plugins', 'staging')), []);
  assert.deepEqual(await manager.rollback(first.manifest.id), { id: first.manifest.id, version: '1.0.0', enabled: false });
  const removed = await manager.remove(first.manifest.id);
  assert.equal(removed.removed, true);
  assert.equal((await stat(removed.recoveryPath)).isDirectory(), true);
  assert.equal((await manager.list()).length, 0);
});

test('validates manager configuration and rejects corrupted durable state', async () => {
  assert.throws(() => new PluginManager({ appDataDirectory: '', trustedKeys: {} }), /app-data directory/);
  assert.throws(() => new PluginManager({ appDataDirectory: [], trustedKeys: {} }), /app-data directory/);

  const previous = process.env.QUIZZER_PLUGIN_TRUSTED_KEYS;
  try {
    process.env.QUIZZER_PLUGIN_TRUSTED_KEYS = '{not-json';
    assert.throws(() => new PluginManager({ appDataDirectory }), /must be a JSON object/);
    for (const encoded of ['[]', 'null', '{"key":42}']) {
      process.env.QUIZZER_PLUGIN_TRUSTED_KEYS = encoded;
      assert.throws(() => new PluginManager({ appDataDirectory }), /must map key ids/);
    }
    process.env.QUIZZER_PLUGIN_TRUSTED_KEYS = '{"release":"public-key"}';
    assert.equal(new PluginManager({ appDataDirectory }).trustedKeys.release, 'public-key');
  } finally {
    if (previous === undefined) delete process.env.QUIZZER_PLUGIN_TRUSTED_KEYS;
    else process.env.QUIZZER_PLUGIN_TRUSTED_KEYS = previous;
  }

  const corrupted = new PluginManager({ appDataDirectory: join(directory, 'corrupted-state'), trustedKeys: {} });
  await corrupted.prepare();
  await writeFile(corrupted.statePath, JSON.stringify({ version: 99, plugins: {} }));
  await assert.rejects(corrupted.readState(), /Plugin state is invalid/);
  await writeFile(corrupted.statePath, '{not-json');
  await assert.rejects(corrupted.readState(), /JSON/);
  assert.throws(() => corrupted.directoryFor('../escape'), /Plugin id is invalid/);
});

test('surfaces broken, incompatible, and unhealthy plugin states', async () => {
  const brokenManager = new PluginManager({ appDataDirectory: join(directory, 'broken-manager'), developerMode: true });
  await brokenManager.prepare();
  await mkdir(join(brokenManager.installedRoot, 'dev.quizzer.broken'));
  await writeFile(join(brokenManager.installedRoot, 'dev.quizzer.broken', 'quizzer.plugin.json'), '{broken');
  await writeFile(join(brokenManager.installedRoot, 'not-a-plugin-directory'), 'ignored');
  const broken = await brokenManager.list();
  assert.equal(broken.length, 1);
  assert.equal(broken[0].status, 'broken');
  assert.match(broken[0].error, /Could not read/);

  const incompatible = await createPlugin('2.0.0', 'incompatible');
  const otherArchitecture = process.arch === 'x64' ? 'arm64' : 'x64';
  incompatible.manifest.platforms = [{ os: process.platform, architectures: [otherArchitecture] }];
  await writeFile(join(incompatible.pluginDirectory, 'quizzer.plugin.json'), JSON.stringify(incompatible.manifest));
  await assert.rejects(brokenManager.install(incompatible.pluginDirectory), /does not support/);

  const occupied = await createPlugin('2.0.1', 'occupied');
  const occupiedManager = new PluginManager({ appDataDirectory: join(directory, 'occupied-manager'), developerMode: true });
  await occupiedManager.prepare();
  await writeFile(occupiedManager.directoryFor(occupied.manifest.id), 'not a directory');
  await assert.rejects(occupiedManager.install(occupied.pluginDirectory), /destination is not a directory/);

  const unhealthy = await createPlugin('2.0.2', 'unhealthy');
  unhealthy.manifest.healthCheck = { method: 'plugin.exit', timeoutMs: 1000 };
  await writeFile(join(unhealthy.pluginDirectory, 'quizzer.plugin.json'), JSON.stringify(unhealthy.manifest));
  const unhealthyManager = new PluginManager({ appDataDirectory: join(directory, 'unhealthy-manager'), developerMode: true });
  await unhealthyManager.install(unhealthy.pluginDirectory);
  const health = await unhealthyManager.health(unhealthy.manifest.id);
  assert.equal(health.ok, false);
  assert.match(health.error, /deliberate plugin exit/);
  await assert.rejects(unhealthyManager.rollback(unhealthy.manifest.id), /No rollback version/);

  unhealthy.manifest.platforms = [{ os: process.platform, architectures: [otherArchitecture] }];
  await writeFile(join(unhealthyManager.directoryFor(unhealthy.manifest.id), 'quizzer.plugin.json'), JSON.stringify(unhealthy.manifest));
  await assert.rejects(unhealthyManager.invoke(unhealthy.manifest.id, 'plugin.echo'), /not compatible/);
});
