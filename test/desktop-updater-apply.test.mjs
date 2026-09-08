import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DesktopUpdater,
  HANDOFF_ALLOWLIST,
  isAutoHandoffSupported,
  resolveHandoffLaunch,
} from '../desktop/updater.mjs';
import { privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const setupTestEnvironment = async (platform = 'macos', format = 'pkg', architecture = 'arm64') => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-updater-apply-test-'));
  const keyPair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

  const artifactContent = Buffer.from('mock installer binary content');
  const sha256 = createHash('sha256').update(artifactContent).digest('hex');
  const artifactName = `quizzer-1.2.0-${platform}-${architecture}.${format}`;

  const unsigned = {
    schemaVersion: 1,
    version: '1.2.0',
    channel: 'stable',
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    signature: '',
    artifacts: [{
      name: artifactName,
      platform,
      architecture,
      format,
      url: `https://github.com/longnt27/quizzer/releases/download/v1.2.0/${artifactName}`,
      size: artifactContent.length,
      sha256,
      minimumOs: 'macOS 13',
    }],
  };
  
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));

  const stagingDir = join(directory, 'updates', 'staging');
  await mkdir(stagingDir, { recursive: true });
  
  await writeFile(join(stagingDir, artifactName), artifactContent);
  
  const stagedPayload = {
    stagedAt: new Date().toISOString(),
    manifest: signed,
    selectedArtifactName: artifactName,
  };
  await writeFile(join(stagingDir, 'staged-update.json'), JSON.stringify(stagedPayload));

  return { directory, keyPair, signed, artifactContent, sha256, artifactName };
};

test('installer handoff allowlist is exact for every supported platform', () => {
  assert.deepEqual(HANDOFF_ALLOWLIST, {
    macos: ['pkg', 'dmg'],
    windows: ['exe', 'msi'],
    linux: ['deb', 'rpm', 'appimage'],
  });
  for (const [platform, formats] of Object.entries(HANDOFF_ALLOWLIST)) {
    for (const format of formats) assert.equal(isAutoHandoffSupported(platform, format), true);
    assert.equal(isAutoHandoffSupported(platform, 'zip'), false);
    assert.equal(isAutoHandoffSupported(platform, 'exe;rm -rf'), false);
  }
  assert.equal(isAutoHandoffSupported('freebsd', 'pkg'), false);
});

test('installer handoff commands use fixed executables and preserve the package as one argument', () => {
  const macPath = '/private staging/Quizzer; harmless.pkg';
  assert.deepEqual(resolveHandoffLaunch(macPath, 'pkg', 'macos'), {
    command: '/usr/bin/open',
    args: [macPath],
  });
  const msiPath = 'C:\\Private staging\\Quizzer & harmless.msi';
  assert.deepEqual(resolveHandoffLaunch(msiPath, 'msi', 'windows'), {
    command: 'C:\\Windows\\System32\\msiexec.exe',
    args: ['/i', msiPath],
  });
  const exePath = 'C:\\Private staging\\Quizzer.exe';
  assert.deepEqual(resolveHandoffLaunch(exePath, 'exe', 'windows'), { command: exePath, args: [] });
  assert.deepEqual(resolveHandoffLaunch('/private/Quizzer.AppImage', 'appimage', 'linux'), {
    command: '/usr/bin/xdg-open',
    args: ['/private/Quizzer.AppImage'],
  });
  assert.throws(() => resolveHandoffLaunch('/tmp/quizzer.zip', 'zip', 'linux'), /Unsupported format/);
  assert.throws(() => resolveHandoffLaunch('', 'deb', 'linux'), /verified package path/);
});

test('applyUpdate succeeds for supported macos pkg and invokes launcher securely', async () => {
  const env = await setupTestEnvironment('macos', 'pkg');
  try {
    let launcherCalled = false;
    let launchedPath;
    let launchedFormat;
    let launchedPlatform;
    
    const launcher = async (path, format, platform) => {
      launcherCalled = true;
      launchedPath = path;
      launchedFormat = format;
      launchedPlatform = platform;
    };
    
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher,
    });

    const result = await updater.applyUpdate({ restart: true });
    
    assert.equal(launcherCalled, true);
    assert.equal(launchedFormat, 'pkg');
    assert.equal(launchedPlatform, 'macos');
    assert.ok(launchedPath.endsWith(env.artifactName));
    assert.equal(result.handoffPending, true);
    assert.equal(result.mechanism, 'staged-ready');
    assert.equal(result.restartRequested, true);
    assert.equal(updater.state, 'installer-handoff-pending');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('applyUpdate leaves unsupported formats in manual-handoff state without launching', async () => {
  const env = await setupTestEnvironment('macos', 'zip'); // zip is unsupported for auto-handoff on macos
  try {
    let launcherCalled = false;
    
    const launcher = async () => {
      launcherCalled = true;
    };
    
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'macos',
      architecture: 'arm64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher,
    });

    const result = await updater.applyUpdate();
    
    assert.equal(launcherCalled, false);
    assert.equal(result.handoffPending, true);
    assert.equal(result.mechanism, 'manual-handoff');
    assert.equal(result.restartRequested, false);
    assert.equal(updater.state, 'manual-handoff');
    assert.match(result.message, /requires manual opening/);
    assert.equal(result.message.includes(env.directory), false);
    assert.equal(result.status.mechanism, 'manual-handoff');
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('applyUpdate propagates launch failure and keeps staged package', async () => {
  const env = await setupTestEnvironment('windows', 'exe', 'x64');
  try {
    const launcher = async () => {
      throw new Error('EACCES: permission denied');
    };
    
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'windows',
      architecture: 'x64',
      isPackaged: true,
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher,
    });

    await assert.rejects(
      updater.applyUpdate(),
      /Installer handoff failed: EACCES: permission denied/,
    );
    
    assert.equal(updater.state, 'error');
    assert.match(updater.lastError, /EACCES/);
    await access(join(env.directory, 'updates', 'staging', env.artifactName));
    await access(join(env.directory, 'updates', 'staging', 'staged-update.json'));
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('applyUpdate bypasses handoff in development mode', async () => {
  const env = await setupTestEnvironment('linux', 'deb', 'x64');
  try {
    let launcherCalled = false;
    
    const launcher = async () => {
      launcherCalled = true;
    };
    
    const updater = new DesktopUpdater({
      userDataDir: env.directory,
      currentVersion: '1.0.0',
      platform: 'linux',
      architecture: 'x64',
      isPackaged: false, // Development mode
      trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
      launcher,
    });

    const result = await updater.applyUpdate({ restart: true });
    
    assert.equal(launcherCalled, false);
    assert.equal(updater.state, 'installer-handoff-pending');
    assert.equal(result.mechanism, 'staged-development');
    assert.equal(result.restartRequested, false);
  } finally {
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('applyUpdate succeeds for supported linux appimage on x64 and arm64 and invokes launcher via xdg-open', async () => {
  for (const architecture of ['x64', 'arm64']) {
    const env = await setupTestEnvironment('linux', 'appimage', architecture);
    try {
      let launcherCalled = false;
      let launchedPath;
      let launchedFormat;
      let launchedPlatform;

      const launcher = async (path, format, platform) => {
        launcherCalled = true;
        launchedPath = path;
        launchedFormat = format;
        launchedPlatform = platform;
      };

      const updater = new DesktopUpdater({
        userDataDir: env.directory,
        currentVersion: '1.0.0',
        platform: 'linux',
        architecture,
        isPackaged: true,
        trustedKeys: { 'quizzer-release-test': env.keyPair.publicKey },
        launcher,
      });

      const handoffLaunch = resolveHandoffLaunch(join(env.directory, 'updates', 'staging', env.artifactName), 'appimage', 'linux');
      assert.deepEqual(handoffLaunch, {
        command: '/usr/bin/xdg-open',
        args: [join(env.directory, 'updates', 'staging', env.artifactName)],
      });

      const result = await updater.applyUpdate({ restart: true });

      assert.equal(launcherCalled, true);
      assert.equal(launchedFormat, 'appimage');
      assert.equal(launchedPlatform, 'linux');
      assert.ok(launchedPath.endsWith(env.artifactName));
      assert.equal(result.handoffPending, true);
      assert.equal(result.mechanism, 'staged-ready');
      assert.equal(result.restartRequested, true);
      assert.equal(updater.state, 'installer-handoff-pending');
    } finally {
      await rm(env.directory, { recursive: true, force: true });
    }
  }
});
