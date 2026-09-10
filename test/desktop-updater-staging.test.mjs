import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { access, chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopUpdater } from '../desktop/updater.mjs';
import { privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const setupTestEnvironment = async (platform = 'macos', architecture = 'arm64', format = 'zip') => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-updater-staging-'));
  const keyPair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const artifactContent = Buffer.from('verified update payload for staging tests');
  const sha256 = createHash('sha256').update(artifactContent).digest('hex');
  const name = `quizzer-1.2.0-${platform}-${architecture}.${format}`;
  const unsigned = {
    schemaVersion: 1,
    version: '1.2.0',
    channel: 'stable',
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    signature: '',
    artifacts: [{
      name,
      platform,
      architecture,
      format,
      url: `https://github.com/longnt27/quizzer/releases/download/v1.2.0/${name}`,
      size: artifactContent.length,
      sha256,
      minimumOs: platform === 'macos' ? 'macOS 13' : 'Ubuntu 22.04',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));
  return { directory, keyPair, artifactContent, signed, name };
};

const createUpdater = (env, fetch, options = {}) => new DesktopUpdater({
  userDataDir: env.directory,
  currentVersion: '1.0.0',
  platform: options.platform || 'macos',
  architecture: options.architecture || 'arm64',
  trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
  fetch,
  ...options,
});

test('scoped staging streams, verifies size and SHA-256, and atomically promotes verified update', async () => {
  const env = await setupTestEnvironment();
  try {
    const updater = createUpdater(env, async url => {
      if (url.endsWith('release-manifest.json')) {
        return { ok: true, text: async () => JSON.stringify(env.signed) };
      }
      if (url.includes('/releases/tags/')) {
        return { ok: true, text: async () => JSON.stringify({ tag_name: 'v1.2.0', draft: false, body: '' }) };
      }
      return { ok: true, arrayBuffer: async () => env.artifactContent };
    });

    const checked = await updater.checkForUpdates();
    assert.equal(checked.state, 'available');
    const downloaded = await updater.downloadUpdate();
    assert.equal(downloaded.state, 'downloaded');

    const stagingDir = join(env.directory, 'updates', 'staging');
    assert.deepEqual((await readdir(stagingDir)).sort(), [env.name, 'staged-update.json'].sort());
    assert.deepEqual(await readFile(join(stagingDir, env.name)), env.artifactContent);
    const metadata = JSON.parse(await readFile(join(stagingDir, 'staged-update.json'), 'utf8'));
    assert.equal(metadata.selectedArtifactName, env.name);
    assert.equal(metadata.manifest.signature, env.signed.signature);
    assert.deepEqual(Object.keys(metadata).sort(), ['manifest', 'selectedArtifactName', 'stagedAt'].sort());
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('download rejects oversized payload and removes unverified temporary files', async () => {
  const env = await setupTestEnvironment();
  try {
    const oversizedContent = Buffer.concat([env.artifactContent, Buffer.from('extra')]);
    const updater = createUpdater(env, async url => {
      if (url.endsWith('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(env.signed) };
      if (url.includes('/releases/tags/')) return { ok: true, text: async () => JSON.stringify({ tag_name: 'v1.2.0', draft: false, body: '' }) };
      return { ok: true, arrayBuffer: async () => oversizedContent };
    });

    await updater.checkForUpdates();
    await assert.rejects(updater.downloadUpdate(), /exceeded expected size/);

    const stagingDir = join(env.directory, 'updates', 'staging');
    const stagingFiles = await readdir(stagingDir).catch(() => []);
    assert.ok(!stagingFiles.includes(env.name));
    assert.ok(!stagingFiles.includes('staged-update.json'));
    assert.ok(stagingFiles.every(file => !file.endsWith('.tmp')));
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('download rejects truncated payload and removes unverified temporary files', async () => {
  const env = await setupTestEnvironment();
  try {
    const truncatedContent = env.artifactContent.subarray(0, env.artifactContent.length - 3);
    const updater = createUpdater(env, async url => {
      if (url.endsWith('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(env.signed) };
      if (url.includes('/releases/tags/')) return { ok: true, text: async () => JSON.stringify({ tag_name: 'v1.2.0', draft: false, body: '' }) };
      return { ok: true, arrayBuffer: async () => truncatedContent };
    });

    await updater.checkForUpdates();
    await assert.rejects(updater.downloadUpdate(), /size mismatch/);

    const stagingDir = join(env.directory, 'updates', 'staging');
    const stagingFiles = await readdir(stagingDir).catch(() => []);
    assert.ok(!stagingFiles.includes(env.name));
    assert.ok(!stagingFiles.includes('staged-update.json'));
    assert.ok(stagingFiles.every(file => !file.endsWith('.tmp')));
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('download rejects tampered SHA-256 and never exposes corrupt binary', async () => {
  const env = await setupTestEnvironment();
  try {
    const tamperedContent = Buffer.from(env.artifactContent);
    tamperedContent[0] ^= 0xff;
    const updater = createUpdater(env, async url => {
      if (url.endsWith('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(env.signed) };
      if (url.includes('/releases/tags/')) return { ok: true, text: async () => JSON.stringify({ tag_name: 'v1.2.0', draft: false, body: '' }) };
      return { ok: true, arrayBuffer: async () => tamperedContent };
    });

    await updater.checkForUpdates();
    await assert.rejects(updater.downloadUpdate(), /SHA-256 mismatch for artifact/);

    const stagingDir = join(env.directory, 'updates', 'staging');
    const stagingFiles = await readdir(stagingDir).catch(() => []);
    assert.ok(!stagingFiles.includes(env.name));
    assert.ok(!stagingFiles.includes('staged-update.json'));
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('downloadUpdate streams through web ReadableStream getReader and updates progress', async () => {
  const env = await setupTestEnvironment();
  try {
    const chunk1 = env.artifactContent.subarray(0, 20);
    const chunk2 = env.artifactContent.subarray(20);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async url => {
        if (url.endsWith('release-manifest.json')) {
          return { ok: true, text: async () => JSON.stringify(env.signed) };
        }
        if (url.includes('/releases/tags/')) {
          return { ok: true, text: async () => JSON.stringify({ tag_name: 'v1.2.0', draft: false, body: '' }) };
        }
        return {
          ok: true,
          body: stream,
        };
      },
    });

    await updater.checkForUpdates();
    const result = await updater.downloadUpdate();
    assert.equal(result.state, 'downloaded');
    assert.equal(updater.downloadProgress?.percent, 100);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('downloadUpdate makes a verified Linux AppImage executable before staging completes', async () => {
  const env = await setupTestEnvironment('linux', 'x64', 'appimage');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'linux',
      architecture: 'x64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async url => {
        if (url.endsWith('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(env.signed) };
        if (url.includes('/releases/tags/')) return { ok: true, text: async () => JSON.stringify({ tag_name: 'v1.2.0', draft: false, body: '' }) };
        return { ok: true, arrayBuffer: async () => env.artifactContent };
      },
    });

    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const artifactPath = join(env.directory, 'updates', 'staging', env.name);
    await access(artifactPath);
    const details = await stat(artifactPath);
    assert.ok((details.mode & 0o100) !== 0);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});
