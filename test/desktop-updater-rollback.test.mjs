import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('apply reverifies signed manifest, never returns applied true, and marks installer handoff pending', async () => {
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

    // Honest semantics: apply does not install binary; it stages and verifies
    assert.equal(applyResult.applied, false);
    assert.equal(applyResult.handoffPending, true);
    assert.equal(applyResult.status.state, 'installer-handoff-pending');
    assert.match(applyResult.message, /installer handoff/i);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('apply reverifies Ed25519 signature on staged-update.json and rejects tampered signature', async () => {
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

    // Tamper with signature in staged-update.json
    const stagedMetaPath = join(env.directory, 'updates', 'staging', 'staged-update.json');
    const stagedData = JSON.parse(await readFile(stagedMetaPath, 'utf8'));
    stagedData.manifest.signature = 'dGVzdC1mYWtlLXNpZ25hdHVyZS10aGF0LWlzLWxvbmctZW5vdWdoLXRvLXZhbGlkYXRl';
    await writeFile(stagedMetaPath, JSON.stringify(stagedData, null, 2));

    await assert.rejects(
      updater.applyUpdate(),
      /Release manifest signature verification failed/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('apply rejects path-substitution in staged-update.json and derives path safely', async () => {
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

    // Attacker modifies staged-update.json to point stagedPath to a sensitive file
    const stagedMetaPath = join(env.directory, 'updates', 'staging', 'staged-update.json');
    const stagedData = JSON.parse(await readFile(stagedMetaPath, 'utf8'));
    stagedData.stagedPath = '/etc/passwd';
    stagedData.sha256 = 'abc';
    await writeFile(stagedMetaPath, JSON.stringify(stagedData, null, 2));

    // Updater must derive path from the reverified manifest artifact name, ignoring stagedPath
    const result = await updater.applyUpdate();
    assert.equal(result.applied, false);
    assert.equal(result.handoffPending, true);
    assert.equal(result.status.state, 'installer-handoff-pending');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('apply rejects staged file if content is tampered on disk before apply', async () => {
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

    // Tamper with file content on disk while preserving length
    const stagedFilePath = join(env.directory, 'updates', 'staging', 'quizzer-1.2.0-macos-arm64.zip');
    const tampered = Buffer.from('X'.repeat(env.content.length));
    await writeFile(stagedFilePath, tampered);

    await assert.rejects(
      updater.applyUpdate(),
      /Staged artifact checksum tampered/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('discardUpdate removes staged files and resets state to idle without fake rollback', async () => {
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

    const stagingDir = join(env.directory, 'updates', 'staging');
    const filesBefore = await readdir(stagingDir);
    assert.ok(filesBefore.length > 0);

    const discardResult = await updater.discardUpdate();
    assert.equal(discardResult.discarded, true);
    assert.equal(discardResult.status.state, 'idle');

    const filesAfter = await readdir(stagingDir);
    assert.equal(filesAfter.length, 0);

    const rollbackResult = await updater.rollbackUpdate();
    assert.equal(rollbackResult.discarded, true);
    assert.equal(rollbackResult.status.state, 'idle');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('applyUpdate in packaged mode reports staged-ready mechanism, handoffPending, and restartRequested', async () => {
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
    assert.equal(result.applied, false);
    assert.equal(result.handoffPending, true);
    assert.equal(result.mechanism, 'staged-ready');
    assert.equal(result.restartRequested, true);
    assert.match(result.message, /Installer handoff pending/);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});
