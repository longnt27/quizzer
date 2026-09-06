import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  compareSemver,
  detectArch,
  detectPlatform,
  parseSemver,
  selectTargetArtifact,
  DesktopUpdater,
} from '../desktop/updater.mjs';
import { buildReleaseManifest, privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

test('detectPlatform and detectArch normalize operating system and architecture', () => {
  assert.equal(detectPlatform('darwin'), 'macos');
  assert.equal(detectPlatform('macos'), 'macos');
  assert.equal(detectPlatform('win32'), 'windows');
  assert.equal(detectPlatform('windows'), 'windows');
  assert.equal(detectPlatform('linux'), 'linux');
  assert.equal(detectPlatform('freebsd'), 'freebsd');

  assert.equal(detectArch('x64'), 'x64');
  assert.equal(detectArch('arm64'), 'arm64');
  assert.equal(detectArch('ia32'), 'ia32');
});

test('semver comparison correctly handles versions and prereleases according to SemVer 2.0.0', () => {
  assert.deepEqual(parseSemver('1.2.3-beta.4'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['beta', '4'],
    raw: '1.2.3-beta.4',
  });
  assert.equal(parseSemver('not-semver'), null);

  // Major, minor, patch comparisons
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.1.0', '1.0.9'), 1);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('0.9.0', '1.0.0'), -1);

  // Full release is strictly newer than its prerelease
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1);

  // Prerelease progression and numeric identifier ordering
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  assert.equal(compareSemver('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0-beta.1'), 0);
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-1'), 1);
});

test('selectTargetArtifact filters for matching OS and architecture, excluding CLI artifacts', () => {
  const artifacts = [
    {
      name: 'quizzer-cli-1.0.0-macos-arm64',
      platform: 'macos',
      architecture: 'arm64',
      format: 'sea',
      cli: true,
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer-cli',
      size: 100,
      sha256: 'a'.repeat(64),
      minimumOs: 'macOS 13',
    },
    {
      name: 'quizzer-1.0.0-macos-arm64.dmg',
      platform: 'macos',
      architecture: 'arm64',
      format: 'dmg',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer.dmg',
      size: 200,
      sha256: 'b'.repeat(64),
      minimumOs: 'macOS 13',
    },
    {
      name: 'quizzer-1.0.0-macos-arm64.zip',
      platform: 'macos',
      architecture: 'arm64',
      format: 'zip',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer.zip',
      size: 150,
      sha256: 'c'.repeat(64),
      minimumOs: 'macOS 13',
    },
    {
      name: 'quizzer-1.0.0-windows-x64.exe',
      platform: 'windows',
      architecture: 'x64',
      format: 'exe',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer.exe',
      size: 300,
      sha256: 'd'.repeat(64),
      minimumOs: 'Windows 10',
    },
    {
      name: 'quizzer-1.0.0-linux-x64.deb',
      platform: 'linux',
      architecture: 'x64',
      format: 'deb',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer.deb',
      size: 250,
      sha256: 'e'.repeat(64),
      minimumOs: 'Ubuntu',
    },
  ];

  // macOS arm64 prefers zip
  const macArm = selectTargetArtifact(artifacts, { platform: 'macos', architecture: 'arm64' });
  assert.equal(macArm.format, 'zip');
  assert.equal(macArm.name, 'quizzer-1.0.0-macos-arm64.zip');

  // Explicit format override
  const macDmg = selectTargetArtifact(artifacts, { platform: 'macos', architecture: 'arm64', preferredFormat: 'dmg' });
  assert.equal(macDmg.format, 'dmg');

  // Windows x64 selects exe
  const win = selectTargetArtifact(artifacts, { platform: 'windows', architecture: 'x64' });
  assert.equal(win.format, 'exe');

  // Linux x64 selects deb
  const linux = selectTargetArtifact(artifacts, { platform: 'linux', architecture: 'x64' });
  assert.equal(linux.format, 'deb');

  // Non-matching target returns null
  assert.equal(selectTargetArtifact(artifacts, { platform: 'linux', architecture: 'arm64' }), null);
  assert.equal(selectTargetArtifact([], { platform: 'macos', architecture: 'arm64' }), null);
});

test('updater transitions to unsupported state when no target artifact matches user system', async () => {
  const keyPair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const unsigned = {
    schemaVersion: 1,
    version: '1.2.0',
    channel: 'stable',
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    signature: '',
    artifacts: [{
      name: 'quizzer-1.2.0-windows-x64.exe',
      platform: 'windows',
      architecture: 'x64',
      format: 'exe',
      url: 'https://github.com/Somethings1/quizzer/releases/download/v1.2.0/quizzer.exe',
      size: 500,
      sha256: 'f'.repeat(64),
      minimumOs: 'Windows 10',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));

  const updater = new DesktopUpdater({
    currentVersion: '1.0.0',
    platform: 'macos',
    architecture: 'arm64',
    trustedKeys: { 'quizzer-release-test': keyPair.publicKey },
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify(signed),
    }),
  });

  const status = await updater.checkForUpdates();
  assert.equal(status.state, 'unsupported');
  assert.match(status.error, /No supported desktop artifact found for macos\/arm64/);
});
