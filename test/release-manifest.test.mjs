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
    url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1/quizzer-macos-arm64.dmg',
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
