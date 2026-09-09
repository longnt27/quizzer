import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopUpdater } from '../desktop/updater.mjs';
import { privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const setupTestEnv = async (version = '1.2.0') => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-state-test-'));
  const keyPair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

  const content = Buffer.from('Quizzer desktop package for state testing');
  const sha256 = createHash('sha256').update(content).digest('hex');

  const unsigned = {
    schemaVersion: 1,
    version,
    channel: version.includes('-') ? 'beta' : 'stable',
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    signature: '',
    artifacts: [{
      name: `quizzer-${version}-macos-arm64.zip`,
      platform: 'macos',
      architecture: 'arm64',
      format: 'zip',
      url: `https://github.com/longnt27/quizzer/releases/download/v${version}/quizzer-${version}-macos-arm64.zip`,
      size: content.length,
      sha256,
      minimumOs: 'macOS 13',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));
  return { directory, keyPair, signed, content };
};

test('state machine transitions properly through full update lifecycle', async () => {
  const env = await setupTestEnv('1.2.0');
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

    assert.equal(updater.state, 'idle');
    const initialStatus = await updater.getStatus();
    assert.equal(initialStatus.state, 'idle');
    assert.equal(initialStatus.currentVersion, '1.0.0');

    // Check
    const checkStatus = await updater.checkForUpdates();
    assert.equal(checkStatus.state, 'available');
    assert.equal(checkStatus.updateInfo?.version, '1.2.0');

    // Download
    const downloadStatus = await updater.downloadUpdate();
    assert.equal(downloadStatus.state, 'downloaded');
    assert.equal(downloadStatus.stagedPath, undefined);
    assert.equal(downloadStatus.stagedArtifactName, 'quizzer-1.2.0-macos-arm64.zip');

    // Apply (verifies staged package and marks installer handoff pending)
    const applyResult = await updater.applyUpdate({ restart: false });
    assert.equal(applyResult.applied, false);
    assert.equal(applyResult.handoffPending, true);
    assert.equal(applyResult.status.state, 'installer-handoff-pending');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('state transitions to up-to-date when current version is equal or newer', async () => {
  const env = await setupTestEnv('1.0.0');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async () => ({ ok: true, text: async () => JSON.stringify(env.signed) }),
    });

    const status = await updater.checkForUpdates();
    assert.equal(status.state, 'up-to-date');
    assert.equal(status.updateInfo, undefined);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('rejects invalid state transitions when prerequisites are missing', async () => {
  const env = await setupTestEnv('1.2.0');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
    });

    // Downloading before check throws
    await assert.rejects(
      updater.downloadUpdate(),
      /No update is currently available to download/,
    );

    // Applying before download throws
    await assert.rejects(
      updater.applyUpdate(),
      /No verified update is ready to apply/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('network failure during check transitions state to error and captures message', async () => {
  const env = await setupTestEnv('1.2.0');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async () => ({ ok: false, status: 503 }),
    });

    const status = await updater.checkForUpdates();
    assert.equal(status.state, 'error');
    assert.match(status.error, /HTTP 503/);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('channel switching resets state and clears previous update info', async () => {
  const env = await setupTestEnv('1.2.0');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async () => ({ ok: true, text: async () => JSON.stringify(env.signed) }),
    });

    await updater.checkForUpdates();
    assert.equal(updater.state, 'available');

    const resetStatus = await updater.setChannel('beta');
    assert.equal(resetStatus.state, 'idle');
    assert.equal(resetStatus.channel, 'beta');
    assert.equal(resetStatus.updateInfo, undefined);

    await assert.rejects(
      updater.setChannel('nightly'),
      /Invalid channel "nightly"/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('channel selection persists in userData atomically and survives restart', async () => {
  const env = await setupTestEnv('1.2.0');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
    });

    assert.equal(updater.channel, 'stable');
    await updater.setChannel('beta');
    assert.equal(updater.channel, 'beta');

    // Simulate restart with a new updater instance on the same userDataDir
    const restarted = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
    });
    assert.equal(restarted.channel, 'beta');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('automatic downloads default on and the user preference persists across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-auto-download-test-'));
  try {
    const updater = new DesktopUpdater({ userDataDir: directory, currentVersion: '1.0.0' });
    assert.equal((await updater.getStatus()).autoDownload, true);

    const disabled = await updater.setAutoDownload(false);
    assert.equal(disabled.autoDownload, false);

    const restarted = new DesktopUpdater({ userDataDir: directory, currentVersion: '1.0.0' });
    assert.equal((await restarted.getStatus()).autoDownload, false);
    await assert.rejects(updater.setAutoDownload('yes'), /autoDownload must be a boolean/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verified staged update is recovered and remains applicable after restart', async () => {
  const env = await setupTestEnv('1.2.0');
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

    const restarted = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
    });
    const recoveredStatus = await restarted.getStatus();

    assert.equal(recoveredStatus.state, 'downloaded');
    assert.equal(recoveredStatus.updateInfo?.version, '1.2.0');
    assert.equal(recoveredStatus.downloadProgress?.percent, 100);
    assert.equal(recoveredStatus.stagedArtifactName, 'quizzer-1.2.0-macos-arm64.zip');

    const applyResult = await restarted.applyUpdate();
    assert.equal(applyResult.handoffPending, true);
    assert.equal(applyResult.status.state, 'installer-handoff-pending');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('discardUpdate clears staging files and resets state to idle', async () => {
  const env = await setupTestEnv('1.2.0');
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
    assert.equal(updater.state, 'downloaded');

    const discardResult = await updater.discardUpdate();
    assert.equal(discardResult.discarded, true);
    assert.equal(discardResult.status.state, 'idle');
    assert.equal(updater.stagedArtifactName, null);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});
