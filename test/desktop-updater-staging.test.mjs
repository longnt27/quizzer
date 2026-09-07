import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopUpdater } from '../desktop/updater.mjs';
import { privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const setupTestEnvironment = async (platform = 'macos', architecture = 'arm64', format = 'zip') => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-updater-test-'));
  const keyPair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

  const artifactContent = Buffer.from('Quizzer desktop package binary content for staging test');
  const sha256 = createHash('sha256').update(artifactContent).digest('hex');

  const unsigned = {
    schemaVersion: 1,
    version: '1.2.0',
    channel: 'stable',
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    signature: '',
    artifacts: [{
      name: `quizzer-1.2.0-${platform}-${architecture}.${format}`,
      platform,
      architecture,
      format,
      url: `https://github.com/Somethings1/quizzer/releases/download/v1.2.0/quizzer-1.2.0-${platform}-${architecture}.${format}`,
      size: artifactContent.length,
      sha256,
      minimumOs: 'macOS 13',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));

  return {
    directory,
    keyPair,
    signed,
    artifactContent,
    sha256,
  };
};

test('scoped staging streams, verifies size and SHA-256, and atomically promotes verified update', async () => {
  const env = await setupTestEnvironment();
  try {
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
        return {
          ok: true,
          arrayBuffer: async () => env.artifactContent,
        };
      },
    });

    await updater.checkForUpdates();
    assert.equal(updater.state, 'available');

    const downloadStatus = await updater.downloadUpdate();
    assert.equal(downloadStatus.state, 'downloaded');
    assert.equal(downloadStatus.stagedPath, undefined);
    assert.equal(downloadStatus.stagedArtifactName, 'quizzer-1.2.0-macos-arm64.zip');

    const stagingDir = join(env.directory, 'updates', 'staging');
    const stagingFiles = await readdir(stagingDir);
    assert.ok(stagingFiles.includes('quizzer-1.2.0-macos-arm64.zip'));
    assert.ok(stagingFiles.includes('staged-update.json'));
    assert.ok(!stagingFiles.some(f => f.endsWith('.tmp') || f.endsWith('.download')));

    const stagedPayload = JSON.parse(await readFile(join(stagingDir, 'staged-update.json'), 'utf8'));
    assert.ok(stagedPayload.manifest);
    assert.equal(stagedPayload.manifest.version, '1.2.0');
    assert.equal(stagedPayload.manifest.signature, env.signed.signature);
    assert.equal(stagedPayload.selectedArtifactName, 'quizzer-1.2.0-macos-arm64.zip');

    const stagedFileContent = await readFile(join(stagingDir, 'quizzer-1.2.0-macos-arm64.zip'));
    assert.deepEqual(stagedFileContent, env.artifactContent);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('download rejects oversized payload and removes unverified temporary files', async () => {
  const env = await setupTestEnvironment();
  try {
    const oversizedContent = Buffer.concat([env.artifactContent, Buffer.from('extra bytes beyond size')]);

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
        return {
          ok: true,
          arrayBuffer: async () => oversizedContent,
        };
      },
    });

    await updater.checkForUpdates();
    await assert.rejects(
      updater.downloadUpdate(),
      /exceeded expected size/,
    );

    const stagingDir = join(env.directory, 'updates', 'staging');
    const stagingFiles = await readdir(stagingDir).catch(() => []);
    assert.ok(!stagingFiles.some(f => f.endsWith('.tmp') || f.endsWith('.download')));
    assert.ok(!stagingFiles.includes('quizzer-1.2.0-macos-arm64.zip'));
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('download rejects truncated payload and removes unverified temporary files', async () => {
  const env = await setupTestEnvironment();
  try {
    const truncatedContent = env.artifactContent.subarray(0, 10);

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
        return {
          ok: true,
          arrayBuffer: async () => truncatedContent,
        };
      },
    });

    await updater.checkForUpdates();
    await assert.rejects(
      updater.downloadUpdate(),
      /Incomplete artifact download/,
    );

    const stagingDir = join(env.directory, 'updates', 'staging');
    const stagingFiles = await readdir(stagingDir).catch(() => []);
    assert.ok(!stagingFiles.includes('quizzer-1.2.0-macos-arm64.zip'));
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('download rejects tampered SHA-256 and never exposes corrupt binary', async () => {
  const env = await setupTestEnvironment();
  try {
    // Same length, but different bytes
    const tamperedContent = Buffer.from(env.artifactContent);
    tamperedContent[0] = tamperedContent[0] ^ 0xff;

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
        return {
          ok: true,
          arrayBuffer: async () => tamperedContent,
        };
      },
    });

    await updater.checkForUpdates();
    await assert.rejects(
      updater.downloadUpdate(),
      /SHA-256 mismatch for artifact/,
    );

    const stagingDir = join(env.directory, 'updates', 'staging');
    const stagingFiles = await readdir(stagingDir).catch(() => []);
    assert.ok(!stagingFiles.includes('quizzer-1.2.0-macos-arm64.zip'));
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
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.artifactContent },
    });

    await updater.checkForUpdates();
    await updater.downloadUpdate();

    const staged = await stat(join(env.directory, 'updates', 'staging', 'quizzer-1.2.0-linux-x64.appimage'));
    assert.notEqual(staged.mode & 0o100, 0);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});
