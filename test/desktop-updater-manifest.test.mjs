import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { DesktopUpdater, normalizePublicKey, validateCanonicalReleaseUrl } from '../desktop/updater.mjs';
import { buildReleaseManifest, canonicalizeManifest, privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const createSignedManifest = async ({
  version = '1.1.0',
  channel = 'stable',
  publicKeyId = 'quizzer-release-test',
  artifacts = [],
  keyPair = generateKeyPairSync('ed25519'),
} = {}) => {
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const unsigned = {
    schemaVersion: 1,
    version,
    channel,
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId,
    signature: '',
    artifacts: artifacts.length ? artifacts : [{
      name: `quizzer-${version}-macos-arm64.zip`,
      platform: 'macos',
      architecture: 'arm64',
      format: 'zip',
      url: `https://github.com/Somethings1/quizzer/releases/download/v${version}/quizzer-${version}-macos-arm64.zip`,
      size: 1024,
      sha256: 'a'.repeat(64),
      minimumOs: 'macOS 13',
    }],
  };
  const signed = signReleaseManifest(unsigned, privateKeyFromBase64(encodedPrivateKey));
  return { signed, keyPair };
};

test('canonical release URLs accept only official GitHub release paths', () => {
  assert.equal(validateCanonicalReleaseUrl('https://github.com/Somethings1/quizzer/releases/download/v1.0.0/manifest.json'), true);
  assert.equal(validateCanonicalReleaseUrl('https://github.com/Somethings1/quizzer/releases/latest/download/manifest.json'), true);
  assert.equal(validateCanonicalReleaseUrl('https://api.github.com/repos/Somethings1/quizzer/releases'), true);
  assert.equal(validateCanonicalReleaseUrl('https://api.github.com/repos/Somethings1/quizzer/releases/tags/v1.0.0'), true);

  // Rejections
  assert.equal(validateCanonicalReleaseUrl('http://github.com/Somethings1/quizzer/releases/latest/download/manifest.json'), false);
  assert.equal(validateCanonicalReleaseUrl('https://user:pass@github.com/Somethings1/quizzer/releases/latest/manifest.json'), false);
  assert.equal(validateCanonicalReleaseUrl('https://github.com/other-org/quizzer/releases/download/v1.0.0/manifest.json'), false);
  assert.equal(validateCanonicalReleaseUrl('https://evil.com/Somethings1/quizzer/releases/latest/download/manifest.json'), false);
  assert.equal(validateCanonicalReleaseUrl('not-a-url'), false);
});

test('manifest verification validates authentic Ed25519 signature with trusted key', async () => {
  const { signed, keyPair } = await createSignedManifest();
  const updater = new DesktopUpdater({
    trustedKeys: { 'quizzer-release-test': keyPair.publicKey },
  });

  const verified = await updater.verifyManifest(JSON.stringify(signed));
  assert.equal(verified.version, '1.1.0');
  assert.equal(verified.signatureAlgorithm, 'ed25519');
});

test('manifest verification rejects untrusted public key ID', async () => {
  const keyPair = generateKeyPairSync('ed25519');
  const otherKeyPair = generateKeyPairSync('ed25519');
  const { signed } = await createSignedManifest({
    publicKeyId: 'unknown-key-2027',
    keyPair,
  });

  const updater = new DesktopUpdater({
    trustedKeys: { 'trusted-key-2026': otherKeyPair.publicKey },
  });

  await assert.rejects(
    updater.verifyManifest(JSON.stringify(signed)),
    /untrusted publicKeyId: "unknown-key-2027"/,
  );
});

test('manifest verification rejects tampered payload and invalid signature', async () => {
  const { signed, keyPair } = await createSignedManifest();
  const updater = new DesktopUpdater({
    trustedKeys: { 'quizzer-release-test': keyPair.publicKey },
  });

  // Tamper version
  const tamperedVersion = { ...signed, version: '1.2.0' };
  await assert.rejects(
    updater.verifyManifest(JSON.stringify(tamperedVersion)),
    /signature verification failed/,
  );

  // Tamper artifact sha256
  const tamperedArtifact = {
    ...signed,
    artifacts: [{ ...signed.artifacts[0], sha256: 'b'.repeat(64) }],
  };
  await assert.rejects(
    updater.verifyManifest(JSON.stringify(tamperedArtifact)),
    /signature verification failed/,
  );

  // Corrupt signature
  const corruptedSig = { ...signed, signature: signed.signature.slice(0, -4) + 'AAAA' };
  await assert.rejects(
    updater.verifyManifest(JSON.stringify(corruptedSig)),
    /signature verification failed/,
  );
});

test('manifest verification enforces schema validation before trusting URLs', async () => {
  const keyPair = generateKeyPairSync('ed25519');
  const encodedPrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const unsignedWithEvilUrl = {
    schemaVersion: 1,
    version: '1.1.0',
    channel: 'stable',
    publishedAt: '2026-09-06T12:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'quizzer-release-test',
    signature: '',
    artifacts: [{
      name: 'quizzer-1.1.0-macos-arm64.zip',
      platform: 'macos',
      architecture: 'arm64',
      format: 'zip',
      url: 'https://evil.com/Somethings1/quizzer/releases/download/v1.1.0/quizzer.zip',
      size: 1024,
      sha256: 'a'.repeat(64),
      minimumOs: 'macOS 13',
    }],
  };
  const rawSignature = sign(null, Buffer.from(canonicalizeManifest(unsignedWithEvilUrl)), keyPair.privateKey).toString('base64url');
  const signedEvil = { ...unsignedWithEvilUrl, signature: rawSignature };
  const updater = new DesktopUpdater({
    trustedKeys: { 'quizzer-release-test': keyPair.publicKey },
  });

  await assert.rejects(
    updater.verifyManifest(JSON.stringify(signedEvil)),
    /schema validation failed: .*GitHub Release URL/,
  );
});

test('reports honest key status when no public key is configured', async () => {
  const updater = new DesktopUpdater();
  const status = updater.getKeyStatus();
  assert.equal(status.configured, false);
  assert.equal(status.trusted, false);
  assert.match(status.message, /No production release public key configured/);

  const { signed } = await createSignedManifest();
  await assert.rejects(
    updater.verifyManifest(JSON.stringify(signed)),
    /No trusted release public key configured/,
  );
});

test('channel filtering respects stable and beta releases', async () => {
  const keyPair = generateKeyPairSync('ed25519');
  const { signed: betaManifest } = await createSignedManifest({
    version: '1.1.0-beta.1',
    channel: 'beta',
    keyPair,
  });

  const updater = new DesktopUpdater({
    currentVersion: '1.0.0',
    channel: 'stable',
    trustedKeys: { 'quizzer-release-test': keyPair.publicKey },
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify(betaManifest),
    }),
  });

  // Checking on stable channel should ignore beta release
  const status = await updater.checkForUpdates();
  assert.equal(status.state, 'up-to-date');
  assert.equal(status.updateInfo, undefined);

  // Switch to beta channel and re-check
  updater.setChannel('beta');
  const betaStatus = await updater.checkForUpdates();
  assert.equal(betaStatus.state, 'available');
  assert.equal(betaStatus.updateInfo.version, '1.1.0-beta.1');
});

test('normalizePublicKey handles PEM, base64 DER SPKI, JWK, and rejects invalid keys', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  const spkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const jwk = publicKey.export({ format: 'jwk' });

  assert.ok(normalizePublicKey(pem));
  assert.ok(normalizePublicKey(spkiBase64));
  assert.ok(normalizePublicKey(jwk));
  assert.ok(normalizePublicKey(publicKey));
  assert.equal(normalizePublicKey(null), null);

  assert.throws(() => normalizePublicKey(privateKey), /KeyObject must be of type public/);
  assert.throws(() => normalizePublicKey(12345), /Unsupported public key format/);
});

test('verifyManifest validates manifest structure and algorithm before crypto operations', async () => {
  const { signed, keyPair } = await createSignedManifest();
  const updater = new DesktopUpdater({
    trustedKeys: { 'quizzer-release-test': keyPair.publicKey },
  });

  await assert.rejects(updater.verifyManifest('{invalid json'), /Invalid release manifest JSON/);
  await assert.rejects(updater.verifyManifest(null), /Release manifest must be a non-empty object/);
  await assert.rejects(
    updater.verifyManifest({ ...signed, signatureAlgorithm: 'rsa' }),
    /Unsupported signature algorithm: rsa/,
  );
  await assert.rejects(
    updater.verifyManifest({ ...signed, signature: '' }),
    /Release manifest is missing signature/,
  );
});

test('updater configures trusted key from QUIZZER_RELEASE_PUBLIC_KEY environment variable', async () => {
  const { signed, keyPair } = await createSignedManifest({ publicKeyId: 'default' });
  const pem = keyPair.publicKey.export({ format: 'pem', type: 'spki' });

  process.env.QUIZZER_RELEASE_PUBLIC_KEY = pem;
  try {
    const updater = new DesktopUpdater({
      fetch: async () => ({ ok: true, text: async () => JSON.stringify(signed) }),
    });
    assert.equal(updater.getKeyStatus().configured, true);
    const verified = await updater.verifyManifest(JSON.stringify(signed));
    assert.equal(verified.version, signed.version);
  } finally {
    delete process.env.QUIZZER_RELEASE_PUBLIC_KEY;
  }
});

