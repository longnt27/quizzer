import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopUpdater } from '../desktop/updater.mjs';
import { privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const setupRollbackEnv = async (format = 'zip') => {
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
      name: `quizzer-1.2.0-macos-arm64.${format}`,
      platform: 'macos',
      architecture: 'arm64',
      format,
      url: `https://github.com/Somethings1/quizzer/releases/download/v1.2.0/quizzer-1.2.0-macos-arm64.${format}`,
      size: content.length,
      sha256,
      minimumOs: 'macOS 13',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));
  return { directory, encodedPrivateKey, keyPair, signed, content, sha256 };
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

test('apply rejects unsigned path-substitution fields in staged-update.json', async () => {
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

    await assert.rejects(
      updater.applyUpdate(),
      /metadata contains unknown fields: stagedPath, sha256/,
    );
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('apply uses the exact signed artifact selected during download', async () => {
  const env = await setupRollbackEnv();
  try {
    const dmgContent = Buffer.from('Quizzer signed DMG package selected explicitly');
    const dmgArtifact = {
      name: 'quizzer-1.2.0-macos-arm64.dmg',
      platform: 'macos',
      architecture: 'arm64',
      format: 'dmg',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.2.0/quizzer-1.2.0-macos-arm64.dmg',
      size: dmgContent.length,
      sha256: createHash('sha256').update(dmgContent).digest('hex'),
      minimumOs: 'macOS 13',
    };
    const signed = signReleaseManifest({
      ...env.signed,
      signature: '',
      artifacts: [...env.signed.artifacts, dmgArtifact],
    }, privateKeyFromBase64(env.encodedPrivateKey));

    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async url => {
        if (url.endsWith('release-manifest.json')) {
          return { ok: true, text: async () => JSON.stringify(signed) };
        }
        return { ok: true, arrayBuffer: async () => url.endsWith('.dmg') ? dmgContent : env.content };
      },
    });

    const checkStatus = await updater.checkForUpdates({ preferredFormat: 'dmg' });
    assert.equal(checkStatus.updateInfo?.artifact.format, 'dmg');
    await updater.downloadUpdate();
    const result = await updater.applyUpdate();

    assert.equal(result.handoffPending, true);
    assert.equal(result.status.stagedArtifactName, dmgArtifact.name);
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
    assert.equal(rollbackResult.rolledBack, false);
    assert.equal(rollbackResult.discarded, undefined);
    assert.equal(rollbackResult.mechanism, 'unavailable');
    assert.match(rollbackResult.message, /No rollback candidate|No verified rollback candidate|not older/);
    assert.equal(rollbackResult.status.state, 'idle');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('retains a verified signed package and recovers it as a rollback candidate after restart', async () => {
  const env = await setupRollbackEnv('pkg');
  let rollbackPath;
  try {
    const options = {
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher: async (path) => { rollbackPath = path; },
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.content },
    };
    const updater = new DesktopUpdater(options);
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const applyResult = await updater.applyUpdate();
    assert.equal(applyResult.handoffPending, true);
    assert.equal((await updater.getStatus()).rollbackInfo.available, false);

    const restarted = new DesktopUpdater({ ...options, currentVersion: '1.3.0' });
    const recovered = await restarted.getStatus();
    assert.equal(recovered.rollbackInfo.available, true);
    assert.equal(recovered.rollbackInfo.version, '1.2.0');
    assert.equal(recovered.rollbackInfo.status, 'verified');

    const rollbackResult = await restarted.rollbackUpdate();
    assert.equal(rollbackResult.rolledBack, false);
    assert.equal(rollbackResult.handoffPending, true);
    assert.equal(rollbackResult.quitRequested, true);
    assert.equal(rollbackResult.mechanism, 'staged-ready');
    assert.equal(rollbackResult.restoredVersion, '1.2.0');
    assert.match(rollbackPath, /updates[\\/]rollback[\\/]candidate-/);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('discarding a new staged update preserves the retained rollback candidate', async () => {
  const env = await setupRollbackEnv('pkg');
  try {
    const options = {
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher: async () => {},
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.content },
    };
    const updater = new DesktopUpdater(options);
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.applyUpdate();
    await updater.checkForUpdates({ force: true });
    await updater.downloadUpdate();
    await updater.discardUpdate();

    const restarted = new DesktopUpdater({ ...options, currentVersion: '1.3.0' });
    assert.equal((await restarted.getStatus()).rollbackInfo.available, true);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('rechecks a candidate after status before rollback handoff', async () => {
  const env = await setupRollbackEnv('pkg');
  let launcherCalled = false;
  try {
    const options = {
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher: async () => { launcherCalled = true; },
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.content },
    };
    const updater = new DesktopUpdater(options);
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.applyUpdate();
    const pointer = JSON.parse(await readFile(join(env.directory, 'updates', 'rollback', 'rollback.json'), 'utf8'));
    const candidateArtifact = join(env.directory, 'updates', 'rollback', pointer.candidateId, env.signed.artifacts[0].name);
    const restarted = new DesktopUpdater({ ...options, currentVersion: '1.3.0' });
    const statusBeforeTamper = await restarted.getStatus();
    assert.equal(statusBeforeTamper.rollbackInfo.available, true);
    await writeFile(candidateArtifact, Buffer.alloc(env.content.length, 'X'));
    const result = await restarted.rollbackUpdate();
    assert.equal(result.rolledBack, false);
    assert.equal(result.mechanism, 'unavailable');
    assert.equal(launcherCalled, true); // only the original update handoff ran
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('rejects rollback pointer path substitution and reports no candidate', async () => {
  const env = await setupRollbackEnv('pkg');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher: async () => {},
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.content },
    });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.applyUpdate();
    const pointerPath = join(env.directory, 'updates', 'rollback', 'rollback.json');
    await writeFile(pointerPath, JSON.stringify({ candidateId: '../outside' }));
    const restarted = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.3.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
    });
    const status = await restarted.getStatus();
    assert.equal(status.rollbackInfo.available, false);
    assert.equal(status.rollbackInfo.status, 'invalid');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('recovers a valid candidate by scanning when the pointer is missing', async () => {
  const env = await setupRollbackEnv('pkg');
  try {
    const options = {
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher: async () => {},
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.content },
    };
    const updater = new DesktopUpdater(options);
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.applyUpdate();
    await rm(join(env.directory, 'updates', 'rollback', 'rollback.json'));

    const restarted = new DesktopUpdater({ ...options, currentVersion: '1.3.0' });
    assert.equal((await restarted.getStatus()).rollbackInfo.available, true);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('rotates verified rollback candidates and bounds retained storage', async () => {
  const env = await setupRollbackEnv('pkg');
  const makeRelease = (version, text) => {
    const content = Buffer.from(text);
    const artifactName = `quizzer-${version}-macos-arm64.pkg`;
    return {
      content,
      manifest: signReleaseManifest({
        schemaVersion: 1,
        version,
        channel: 'stable',
        publishedAt: '2026-09-06T12:00:00.000Z',
        signatureAlgorithm: 'ed25519',
        publicKeyId: 'quizzer-release-test',
        signature: '',
        artifacts: [{
          name: artifactName,
          platform: 'macos',
          architecture: 'arm64',
          format: 'pkg',
          url: `https://github.com/Somethings1/quizzer/releases/download/v${version}/${artifactName}`,
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          minimumOs: 'macOS 13',
        }],
      }, privateKeyFromBase64(env.encodedPrivateKey)),
    };
  };
  try {
    let release = makeRelease('1.1.0', 'Quizzer 1.1 installer');
    const options = {
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher: async () => {},
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(release.manifest) }
        : { ok: true, arrayBuffer: async () => release.content },
    };
    const first = new DesktopUpdater(options);
    await first.checkForUpdates();
    await first.downloadUpdate();
    await first.applyUpdate();

    release = makeRelease('1.2.0', 'Quizzer 1.2 installer');
    const second = new DesktopUpdater({ ...options, currentVersion: '1.1.0' });
    await second.checkForUpdates();
    await second.downloadUpdate();
    await second.applyUpdate();

    const restarted = new DesktopUpdater({ ...options, currentVersion: '1.2.0' });
    const status = await restarted.getStatus();
    assert.equal(status.rollbackInfo.available, true);
    assert.equal(status.rollbackInfo.version, '1.1.0');
    const candidateEntries = (await readdir(join(env.directory, 'updates', 'rollback'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('candidate-'));
    assert.ok(candidateEntries.length <= 3);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('rejects rollback while a staged update is ready or another operation is active', async () => {
  const env = await setupRollbackEnv('pkg');
  try {
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.content },
    });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await assert.rejects(updater.rollbackUpdate(), /updater state is downloaded/);
    updater.state = 'idle';
    updater.operationInFlight = 'download';
    await assert.rejects(updater.rollbackUpdate(), /download is in progress/);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('reports unsupported rollback package handoff without launching it', async () => {
  const env = await setupRollbackEnv('zip');
  let launcherCalled = false;
  try {
    const options = {
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher: async () => { launcherCalled = true; },
      fetch: async url => url.endsWith('release-manifest.json')
        ? { ok: true, text: async () => JSON.stringify(env.signed) }
        : { ok: true, arrayBuffer: async () => env.content },
    };
    const updater = new DesktopUpdater(options);
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.retainRollbackCandidate({ artifact: updater.updateInfo.artifact, manifest: env.signed });
    const restarted = new DesktopUpdater({ ...options, currentVersion: '1.3.0' });
    const result = await restarted.rollbackUpdate();
    assert.equal(result.rolledBack, false);
    assert.equal(result.handoffPending, false);
    assert.equal(result.mechanism, 'manual-handoff');
    assert.match(result.message, /requires manual opening/);
    assert.equal(launcherCalled, false);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('applyUpdate in packaged mode reports staged-ready mechanism, handoffPending, and restartRequested', async () => {
  // Use dmg format (handoff-capable on macOS) to test the full staged-ready path
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
      name: 'quizzer-1.2.0-macos-arm64.dmg',
      platform: 'macos',
      architecture: 'arm64',
      format: 'dmg',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.2.0/quizzer-1.2.0-macos-arm64.dmg',
      size: content.length,
      sha256,
      minimumOs: 'macOS 13',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));

  try {
    const updater = new DesktopUpdater({
      userDataDir: directory,
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'macos',
      architecture: 'arm64',
      trustedKeys: { 'quizzer-release-test': keyPair.publicKey },
      launcher: async () => {},
      fetch: async url => {
        if (url.endsWith('release-manifest.json')) {
          return { ok: true, text: async () => JSON.stringify(signed) };
        }
        return { ok: true, arrayBuffer: async () => content };
      },
    });

    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const result = await updater.applyUpdate({ restart: true });
    assert.equal(result.applied, false);
    assert.equal(result.handoffPending, true);
    assert.equal(result.mechanism, 'staged-ready');
    assert.equal(result.restartRequested, true);
    assert.match(result.message, /handed off to system installer/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
