import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertPluginTrust, isPluginCompatible, loadPluginManifest, pluginSignaturePayload,
  validatePluginManifest, verifyPluginFiles, verifyPluginSignature,
} from '../plugin-sdk/manifest.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-plugin-manifest-test-'));
const entrypoint = 'plugin.mjs';
const source = 'process.stdin.pipe(process.stdout);\n';
const digest = createHash('sha256').update(source).digest('hex');
const manifest = {
  schemaVersion: 1,
  id: 'dev.quizzer.echo',
  name: 'Echo plugin',
  description: 'Test JSON-RPC plugin',
  version: '1.0.0',
  protocolVersion: 1,
  entrypoint,
  capabilities: ['generator'],
  platforms: [{ os: process.platform, architectures: [process.arch] }],
  resources: { memoryMB: 32, diskMB: 1, accelerators: ['cpu'] },
  configuration: { type: 'object', additionalProperties: false },
  permissions: { network: [], filesystem: ['scoped-temp'], secrets: [], subprocess: false },
  healthCheck: { method: 'plugin.health', timeoutMs: 1000 },
  files: [{ path: entrypoint, sha256: digest }],
};

test.before(async () => {
  await writeFile(join(directory, entrypoint), source);
  await writeFile(join(directory, 'quizzer.plugin.json'), JSON.stringify(manifest));
});
test.after(async () => rm(directory, { recursive: true, force: true }));

test('validates manifest capabilities, compatibility, paths, and file hashes', async () => {
  assert.equal(validatePluginManifest(manifest), manifest);
  assert.equal(isPluginCompatible(manifest), true);
  assert.equal((await loadPluginManifest(directory)).id, manifest.id);
  assert.equal(await verifyPluginFiles(directory, manifest), true);
  assert.throws(() => validatePluginManifest({ ...manifest, entrypoint: '../escape.mjs' }), /Unsafe plugin path/);
  assert.throws(() => validatePluginManifest({ ...manifest, capabilities: ['unknown'] }), /capabilities/);
  await assert.rejects(verifyPluginFiles(directory, {
    ...manifest, files: [{ path: entrypoint, sha256: '0'.repeat(64) }],
  }), /hash mismatch/);
});

test('requires developer mode for unsigned local plugins', () => {
  assert.throws(() => assertPluginTrust(manifest), /Developer Mode/);
  assert.equal(assertPluginTrust(manifest, { developerMode: true }), 'unsigned-local');
});

test('verifies Ed25519 signatures over canonical manifest metadata', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signed = {
    ...manifest,
    signature: { algorithm: 'ed25519', keyId: 'test-key', value: '' },
  };
  delete signed.signature;
  signed.signature = {
    algorithm: 'ed25519',
    keyId: 'test-key',
    value: sign(null, pluginSignaturePayload(signed), privateKey).toString('base64'),
  };
  const trustedKeys = { 'test-key': publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  assert.equal(verifyPluginSignature(signed, trustedKeys), true);
  assert.equal(assertPluginTrust(signed, { trustedKeys }), 'signed');
  assert.throws(() => verifyPluginSignature({ ...signed, name: 'Tampered' }, trustedKeys), /verification failed/);
});
