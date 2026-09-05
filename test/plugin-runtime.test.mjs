import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === 'plugin.wait') await new Promise(resolve => setTimeout(resolve, 5000));
  const result = request.method === 'plugin.health'
    ? { status: 'ready', version: process.env.PLUGIN_VERSION }
    : {
        params: request.params,
        configuration: request.context.configuration,
        temporaryDirectory: request.context.temporaryDirectory,
        allowedSecret: process.env.TEST_PLUGIN_KEY,
        hiddenSecret: process.env.UNDECLARED_PLUGIN_KEY,
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
  });
  assert.deepEqual(invocation.result.params, { value: 42 });
  assert.deepEqual(invocation.result.configuration, { mode: 'test' });
  assert.equal(invocation.result.allowedSecret, 'allowed');
  assert.equal(invocation.result.hiddenSecret, undefined);
  await assert.rejects(stat(invocation.result.temporaryDirectory), /ENOENT/);

  const controller = new AbortController();
  const waiting = invokePluginProcess({
    appDataDirectory, directory: pluginDirectory, manifest, method: 'plugin.wait', signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(waiting, error => error.name === 'AbortError');
});

test('installs, blocks, enables, checks, upgrades, rolls back, and removes plugins', async () => {
  const first = await createPlugin('1.0.0', 'first');
  const manager = new PluginManager({ appDataDirectory, developerMode: true });
  const installed = await manager.install(first.pluginDirectory);
  assert.equal(installed.trust, 'unsigned-local');
  assert.equal(installed.enabled, true);
  assert.match(installed.warning, /Unsigned local plugin/);

  const lockedManager = new PluginManager({ appDataDirectory, developerMode: false });
  assert.equal((await lockedManager.list())[0].status, 'blocked');
  await assert.rejects(lockedManager.invoke(first.manifest.id, 'plugin.echo'), /Developer Mode/);

  assert.equal((await manager.health(first.manifest.id)).ok, true);
  assert.equal((await manager.setEnabled(first.manifest.id, false)).enabled, false);
  await assert.rejects(manager.invoke(first.manifest.id, 'plugin.echo'), /disabled/);
  await manager.setEnabled(first.manifest.id, true);

  const second = await createPlugin('1.1.0', 'second');
  assert.equal((await manager.install(second.pluginDirectory)).version, '1.1.0');
  assert.deepEqual(await manager.rollback(first.manifest.id), { id: first.manifest.id, version: '1.0.0', enabled: false });
  const removed = await manager.remove(first.manifest.id);
  assert.equal(removed.removed, true);
  assert.equal((await stat(removed.recoveryPath)).isDirectory(), true);
  assert.equal((await manager.list()).length, 0);
});
