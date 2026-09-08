import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  RELEASE_PUBLIC_KEY_ID,
  RELEASE_PUBLIC_KEY_PEM,
  RELEASE_PUBLIC_KEY_RAW_BASE64,
  RELEASE_TRUSTED_KEYS,
  validateReleaseSigningConfiguration,
} from '../release/trust.mjs';
import {
  RELEASE_PUBLIC_KEY_ID as LANDING_KEY_ID,
  RELEASE_PUBLIC_KEY_RAW_BASE64 as LANDING_PUBLIC_KEY,
} from '../landing/lib/release-trust.mjs';

test('desktop and landing embed the same production release trust anchor', () => {
  assert.equal(LANDING_KEY_ID, RELEASE_PUBLIC_KEY_ID);
  assert.equal(LANDING_PUBLIC_KEY, RELEASE_PUBLIC_KEY_RAW_BASE64);
  assert.equal(RELEASE_TRUSTED_KEYS[RELEASE_PUBLIC_KEY_ID], RELEASE_PUBLIC_KEY_PEM);
});

test('release signing configuration accepts only the matching key pair and metadata', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const publicKeyRawBase64 = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  const expected = {
    expectedPublicKeyId: 'test-key',
    expectedPublicKeyRawBase64: publicKeyRawBase64,
    trustedPublicKeyPem: publicKeyPem,
  };

  assert.equal(validateReleaseSigningConfiguration({
    privateKeyBase64, publicKeyId: 'test-key', publicKeyRawBase64, ...expected,
  }), true);
  assert.throws(() => validateReleaseSigningConfiguration({
    privateKeyBase64, publicKeyId: 'wrong-key', publicKeyRawBase64, ...expected,
  }), /PUBLIC_KEY_ID/);
  assert.throws(() => validateReleaseSigningConfiguration({
    privateKeyBase64, publicKeyId: 'test-key', publicKeyRawBase64: 'wrong', ...expected,
  }), /PUBLIC_KEY does not match/);

  const unrelated = generateKeyPairSync('ed25519').privateKey
    .export({ format: 'der', type: 'pkcs8' }).toString('base64');
  assert.throws(() => validateReleaseSigningConfiguration({
    privateKeyBase64: unrelated, publicKeyId: 'test-key', publicKeyRawBase64, ...expected,
  }), /PRIVATE_KEY does not match/);
  assert.throws(() => validateReleaseSigningConfiguration({
    privateKeyBase64: 'invalid', publicKeyId: 'test-key', publicKeyRawBase64, ...expected,
  }), /valid base64 PKCS#8/);
});
