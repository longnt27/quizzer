import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopUpdater } from '../desktop/updater.mjs';
import { privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const setupRollbackEnv = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-rollback-test-'));
  const keyPair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

  const content = Buffer.from('Quizzer binary package content for rollback tests');
  const sha256 = createHash('sha256').update(content).digest('hex');

  const unsigned = {
    schemaVersion: 1,
    version: '1.2.0',
    channel: 'stable',
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    signature: '',
    artifacts: [{
      name: 'quizzer-1.2.0-macos-arm64.zip',
      platform: 'macos',
      architecture: 'arm64',
      format: 'zip',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.2.0/quizzer-1.2.0-macos-arm64.zip',
      size: content.length,
      sha256,
      minimumOs: 'macOS 13',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));
  return { directory, keyPair, signed, content, sha256 };
};

test('retains recoverable prior version metadata upon applying an update', async () => {
  const env = await setupRollbackEnv();
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
        return { ok: true, arrayBuffer: async () => env.content };
      },
    });

    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const applyResult = await updater.applyUpdate();
    assert.equal(applyResult.applied, true);

    const rollbackMetaPath = join(env.directory, 'updates', 'rollback', 'rollback-metadata.json');
    const rollbackMeta = JSON.parse(await readFile(rollbackMetaPath, 'utf8'));
    assert.equal(rollbackMeta.status, 'available');
    assert.equal(rollbackMeta.currentVersion, '1.0.0');
    assert.equal(rollbackMeta.targetVersion, '1.2.0');
    assert.equal(rollbackMeta.stagedArtifactName, 'quizzer-1.2.0-macos-arm64.zip');

    const rollbackInfo = await updater.getRollbackInfo();
    assert.equal(rollbackInfo.available, true);
    assert.equal(rollbackInfo.version, '1.0.0');
    assert.equal(rollbackInfo.targetVersion, '1.2.0');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('apply rejects staged file if tampered on disk before apply', async () => {
  const env = await setupRollbackEnv();
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
        return { ok: true, arrayBuffer: async () => env.content };
      },
    });

    await updater.checkForUpdates();
    await updater.downloadUpdate();

    // Tamper with file in staging before apply
    const stagedFilePath = join(env.directory, 'updates', 'staging', 'quizzer-1.2.0-macos-arm64.zip');
    await writeFile(stagedFilePath, 'tampered content instead');

    await assert.rejects(
      updater.applyUpdate(),
      /Staged artifact file size tampered/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('rollback transitions metadata to restored and prevents double rollback', async () => {
  const env = await setupRollbackEnv();
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
        return { ok: true, arrayBuffer: async () => env.content };
      },
    });

    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.applyUpdate();

    const rollbackResult = await updater.rollbackUpdate();
    assert.equal(rollbackResult.rolledBack, true);
    assert.equal(rollbackResult.restoredVersion, '1.0.0');
    assert.equal(rollbackResult.status.state, 'rolled-back');

    const rollbackInfo = await updater.getRollbackInfo();
    assert.equal(rollbackInfo.available, false);
    assert.equal(rollbackInfo.status, 'restored');

    // Attempting a second rollback should fail
    await assert.rejects(
      updater.rollbackUpdate(),
      /Cannot rollback: rollback status is "restored"/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('rollback reports honest error when no rollback metadata exists', async () => {
  const env = await setupRollbackEnv();
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
    });

    await assert.rejects(
      updater.rollbackUpdate(),
      /No rollback metadata available/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('applyUpdate in packaged mode reports staged-ready mechanism and restartRequested', async () => {
  const env = await setupRollbackEnv();
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async url => {
        if (url.endsWith('release-manifest.json')) {
          return { ok: true, text: async () => JSON.stringify(env.signed) };
        }
        return { ok: true, arrayBuffer: async () => env.content };
      },
    });

    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const result = await updater.applyUpdate({ restart: true });
    assert.equal(result.applied, true);
    assert.equal(result.mechanism, 'staged-ready');
    assert.equal(result.restartRequested, true);
    assert.match(result.message, /staged for application on restart/);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

