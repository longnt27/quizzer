import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertPluginTrust, isPluginCompatible, loadPluginManifest, pluginSignaturePayload,
  validatePluginManifest, validatePluginPath, verifyPluginFiles, verifyPluginSignature,
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

test('rejects malformed values in every plugin manifest section', () => {
  const invalid = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...manifest, schemaVersion: 2 }, /schema version/],
    [{ ...manifest, protocolVersion: 2 }, /protocol version/],
    [{ ...manifest, id: 'Invalid Plugin' }, /id is invalid/],
    [{ ...manifest, name: '' }, /name must be/],
    [{ ...manifest, description: 42 }, /description/],
    [{ ...manifest, version: '01.0.0' }, /semantic versioning/],
    [{ ...manifest, capabilities: [] }, /capabilities/],
    [{ ...manifest, capabilities: ['generator', 'generator'] }, /capabilities/],
    [{ ...manifest, platforms: [] }, /platforms/],
    [{ ...manifest, platforms: [null] }, /platform must be an object/],
    [{ ...manifest, platforms: [{ os: 'aix', architectures: ['x64'] }] }, /operating system/],
    [{ ...manifest, platforms: [{ os: process.platform, architectures: [] }] }, /architectures/],
    [{ ...manifest, platforms: [{ os: process.platform, architectures: ['mips'] }] }, /architectures/],
    [{ ...manifest, resources: null }, /resources must be an object/],
    [{ ...manifest, resources: { ...manifest.resources, memoryMB: -1 } }, /memoryMB/],
    [{ ...manifest, resources: { ...manifest.resources, diskMB: 1.5 } }, /diskMB/],
    [{ ...manifest, resources: { ...manifest.resources, accelerators: ['tpu'] } }, /accelerators/],
    [{ ...manifest, configuration: null }, /configuration must be an object/],
    [{ ...manifest, permissions: { ...manifest.permissions, network: [false] } }, /network permissions/],
    [{ ...manifest, permissions: { ...manifest.permissions, filesystem: ['everything'] } }, /filesystem permissions/],
    [{ ...manifest, permissions: { ...manifest.permissions, secrets: ['lowercase'] } }, /secret permissions/],
    [{ ...manifest, permissions: { ...manifest.permissions, subprocess: 'no' } }, /subprocess permission/],
    [{ ...manifest, healthCheck: null }, /health check must be an object/],
    [{ ...manifest, healthCheck: { ...manifest.healthCheck, method: '' } }, /health-check method/],
    [{ ...manifest, healthCheck: { ...manifest.healthCheck, timeoutMs: 99 } }, /timeout/],
    [{ ...manifest, files: [] }, /files are required/],
    [{ ...manifest, files: [null] }, /file must be an object/],
    [{ ...manifest, files: [{ path: entrypoint, sha256: 'invalid' }] }, /Invalid SHA-256/],
    [{ ...manifest, files: [manifest.files[0], manifest.files[0]] }, /Duplicate plugin file/],
    [{ ...manifest, entrypoint: 'other.mjs' }, /entrypoint must be included/],
    [{ ...manifest, signature: { algorithm: 'rsa', keyId: 'key', value: 'signature' } }, /Ed25519/],
    [{ ...manifest, signature: { algorithm: 'ed25519', keyId: '', value: 'signature' } }, /key id/],
    [{ ...manifest, signature: { algorithm: 'ed25519', keyId: 'key', value: '' } }, /signature value/],
  ];
  for (const [candidate, pattern] of invalid) {
    assert.throws(() => validatePluginManifest(candidate), pattern);
  }

  for (const path of ['', '/absolute/plugin.mjs', 'nested\\plugin.mjs', 'nested//plugin.mjs', './plugin.mjs', 'nested/../plugin.mjs']) {
    assert.throws(() => validatePluginPath(path), /Plugin path|Unsafe plugin path/);
  }
  assert.equal(isPluginCompatible(manifest, { platform: 'aix', architecture: 'mips' }), false);
});

test('loads manifests without file verification and explains unreadable manifests', async () => {
  assert.equal((await loadPluginManifest(directory, { verifyFiles: false })).id, manifest.id);

  const malformed = join(directory, 'malformed');
  await mkdir(malformed);
  await writeFile(join(malformed, 'quizzer.plugin.json'), '{not json');
  await assert.rejects(loadPluginManifest(malformed), /Could not read quizzer\.plugin\.json/);

  const directoryManifest = join(directory, 'directory-manifest');
  await mkdir(join(directoryManifest, 'quizzer.plugin.json'), { recursive: true });
  await assert.rejects(loadPluginManifest(directoryManifest), /manifest must be a regular file/);
});

test('rejects symbolic links in verified plugin payloads', { skip: process.platform === 'win32' }, async () => {
  const linkedDirectory = join(directory, 'linked');
  await mkdir(linkedDirectory);
  await symlink(join(directory, entrypoint), join(linkedDirectory, 'linked.mjs'));
  const linkedManifest = {
    ...manifest,
    entrypoint: 'linked.mjs',
    files: [{ path: 'linked.mjs', sha256: digest }],
  };
  await assert.rejects(verifyPluginFiles(linkedDirectory, linkedManifest), /regular file/);
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
  assert.equal(verifyPluginSignature(manifest, trustedKeys), false);
  assert.equal(assertPluginTrust(signed, { trustedKeys }), 'signed');
  assert.equal(verifyPluginSignature(signed, { 'test-key': publicKey.export({ format: 'pem', type: 'spki' }).toString() }), true);
  assert.throws(() => verifyPluginSignature(signed, {}), /not trusted/);
  assert.throws(() => verifyPluginSignature({ ...signed, name: 'Tampered' }, trustedKeys), /verification failed/);
});
