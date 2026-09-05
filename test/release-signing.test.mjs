import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReleaseManifest, canonicalizeManifest, privateKeyFromBase64, signReleaseManifest, verifyReleaseManifestSignature } from '../release/manifest.mjs';
import { validateReleaseManifest } from '../server/release-manifest.mjs';

test('hashes and signs a deterministic release manifest that rejects tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-release-'));
  try {
    const artifactPath = join(directory, 'quizzer-macos-arm64.zip');
    await writeFile(artifactPath, 'signed Quizzer artifact');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const encodedPrivateKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const unsigned = await buildReleaseManifest({
      version: '1.0.0-beta.1',
      channel: 'beta',
      publishedAt: '2026-09-05T00:00:00.000Z',
      publicKeyId: 'quizzer-release-test',
      releaseUrl: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1',
      artifacts: [{
        path: artifactPath,
        platform: 'macos',
        architecture: 'arm64',
        format: 'zip',
        minimumOs: 'macOS 13',
      }],
    });
    const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));
    assert.deepEqual(validateReleaseManifest(signed), { valid: true, errors: [] });
    assert.equal(verifyReleaseManifestSignature(signed, publicKey), true);
    assert.equal(signed.artifacts[0].sha256, 'f518a6468fa145a5c573f657bd3463284eca015e597b65d4d8bda70d92862afa');
    assert.equal(canonicalizeManifest(signed), canonicalizeManifest({ ...signed, signature: 'ignored' }));
    assert.equal(verifyReleaseManifestSignature({ ...signed, version: '1.0.1' }, publicKey), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
