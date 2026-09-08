import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseManifest } from '../server/release-manifest.mjs';

const manifest = {
  schemaVersion: 1,
  version: '1.0.0-beta.1',
  channel: 'beta',
  publishedAt: '2026-09-05T00:00:00.000Z',
  signatureAlgorithm: 'ed25519',
  publicKeyId: 'quizzer-release-2026',
  signature: 'dGVzdC1zaWduYXR1cmUtdGhhdC1pcy1sb25nLWVub3VnaC10by12YWxpZGF0ZQ==',
  artifacts: [{
    name: 'quizzer-macos-arm64.dmg',
    platform: 'macos',
    architecture: 'arm64',
    format: 'dmg',
    url: 'https://github.com/longnt27/quizzer/releases/download/v1.0.0-beta.1/quizzer-macos-arm64.dmg',
    size: 100,
    sha256: 'a'.repeat(64),
    minimumOs: 'macOS 13',
  }],
};

test('accepts a complete signed GitHub release manifest', () => {
  assert.deepEqual(validateReleaseManifest(manifest), { valid: true, errors: [] });
});

test('rejects untrusted downloads, invalid hashes, and duplicate targets', () => {
  const invalid = {
    ...manifest,
    artifacts: [
      { ...manifest.artifacts[0], url: 'https://example.com/quizzer.dmg', sha256: 'ABC' },
      { ...manifest.artifacts[0], name: 'duplicate.dmg' },
    ],
  };
  const result = validateReleaseManifest(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('GitHub Release URL')));
  assert.ok(result.errors.some(error => error.includes('SHA-256')));
  assert.ok(result.errors.some(error => error.includes('duplicates target')));
});

test('reports every malformed release and artifact field', () => {
  assert.deepEqual(validateReleaseManifest(null), { valid: false, errors: ['Manifest must be an object'] });
  assert.deepEqual(validateReleaseManifest([]), { valid: false, errors: ['Manifest must be an object'] });

  const invalid = {
    schemaVersion: 2,
    version: 'release-one',
    channel: 'nightly',
    publishedAt: 'not-a-date',
    signatureAlgorithm: 'rsa',
    publicKeyId: '',
    signature: 'short',
    artifacts: [
      null,
      {
        name: '',
        platform: 'android',
        architecture: 'mips',
        format: 'apk',
        url: 'not a url',
        size: 0,
        sha256: 'A'.repeat(64),
        minimumOs: '',
      },
    ],
  };
  const result = validateReleaseManifest(invalid);
  assert.equal(result.valid, false);
  for (const expected of [
    'schemaVersion', 'version', 'channel', 'publishedAt', 'signatureAlgorithm', 'publicKeyId', 'signature',
    'artifacts[0] must be an object', 'artifacts[1].name', 'artifacts[1].platform', 'artifacts[1].architecture',
    'artifacts[1].format', 'artifacts[1].url', 'artifacts[1].size', 'artifacts[1].sha256', 'artifacts[1].minimumOs',
  ]) {
    assert.ok(result.errors.some(error => error.includes(expected)), `expected an error for ${expected}`);
  }

  assert.ok(validateReleaseManifest({ ...manifest, artifacts: [] }).errors.some(error => error.includes('artifacts')));
  for (const url of [
    'http://github.com/longnt27/quizzer/releases/download/v1/file.zip',
    'https://example.com/longnt27/quizzer/releases/download/v1/file.zip',
    'https://github.com/another/project/releases/download/v1/file.zip',
  ]) {
    assert.ok(validateReleaseManifest({ ...manifest, artifacts: [{ ...manifest.artifacts[0], url }] }).errors.some(error => error.includes('GitHub Release URL')));
  }
});

test('hardens artifact names against separators, dot paths, traversal, controls, and length', () => {
  const badNames = [
    '../traversal.zip',
    'dir/sub.zip',
    'dir\\sub.zip',
    '.dotfile.zip',
    'ends-with-dot.',
    'has..dotdot.zip',
    'null\0byte.zip',
    'control\x1fname.zip',
    'space in name.zip',
    'a'.repeat(129),
    '',
  ];

  for (const name of badNames) {
    const res = validateReleaseManifest({
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], name }],
    });
    assert.equal(res.valid, false, `Expected invalid for artifact name: "${name}"`);
    assert.ok(res.errors.some(e => e.includes('.name is invalid')), `Expected name error for: "${name}"`);
  }

  // Valid names
  for (const name of [
    'quizzer-1.0.0-macos-arm64.zip',
    'quizzer-1.0.0-beta.1-windows-x64.exe',
    'quizzer_2.0.deb',
    'app-arm64.tar.gz',
  ]) {
    const res = validateReleaseManifest({
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], name }],
    });
    assert.equal(res.valid, true, `Expected valid for artifact name: "${name}"`);
  }
});

test('bounds artifact size to defensible desktop package maximum', () => {
  // Exceeds 1 GiB
  const oversized = validateReleaseManifest({
    ...manifest,
    artifacts: [{ ...manifest.artifacts[0], size: 1024 * 1024 * 1024 + 1 }],
  });
  assert.equal(oversized.valid, false);
  assert.ok(oversized.errors.some(e => e.includes('size must be a positive integer not exceeding')));

  // Zero and negative sizes
  assert.equal(validateReleaseManifest({ ...manifest, artifacts: [{ ...manifest.artifacts[0], size: 0 }] }).valid, false);
  assert.equal(validateReleaseManifest({ ...manifest, artifacts: [{ ...manifest.artifacts[0], size: -500 }] }).valid, false);
});
