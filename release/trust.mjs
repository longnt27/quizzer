import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';

export const RELEASE_PUBLIC_KEY_ID = 'quizzer-release-2026-09';
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAaB0kq9POjdj3gUQnYCppnSwdp0Kyj5wjAnHm4ZL288g=
-----END PUBLIC KEY-----`;
export const RELEASE_PUBLIC_KEY_RAW_BASE64 = 'aB0kq9POjdj3gUQnYCppnSwdp0Kyj5wjAnHm4ZL288g=';

export const RELEASE_TRUSTED_KEYS = Object.freeze({
  [RELEASE_PUBLIC_KEY_ID]: RELEASE_PUBLIC_KEY_PEM,
});

export const validateReleaseSigningConfiguration = ({
  privateKeyBase64,
  publicKeyId,
  publicKeyRawBase64,
  expectedPublicKeyId = RELEASE_PUBLIC_KEY_ID,
  expectedPublicKeyRawBase64 = RELEASE_PUBLIC_KEY_RAW_BASE64,
  trustedPublicKeyPem = RELEASE_PUBLIC_KEY_PEM,
}) => {
  if (publicKeyId !== expectedPublicKeyId) {
    throw new Error(`QUIZZER_RELEASE_PUBLIC_KEY_ID must be ${expectedPublicKeyId}`);
  }
  if (publicKeyRawBase64 !== expectedPublicKeyRawBase64) {
    throw new Error('QUIZZER_RELEASE_PUBLIC_KEY does not match the public key embedded in Quizzer');
  }
  if (typeof privateKeyBase64 !== 'string' || !privateKeyBase64.trim()) {
    throw new Error('QUIZZER_RELEASE_PRIVATE_KEY is required');
  }

  let derivedPublicKey;
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyBase64.trim(), 'base64'), format: 'der', type: 'pkcs8',
    });
    derivedPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  } catch {
    throw new Error('QUIZZER_RELEASE_PRIVATE_KEY must be a valid base64 PKCS#8 Ed25519 private key');
  }

  const trustedPublicKey = createPublicKey(trustedPublicKeyPem).export({ format: 'der', type: 'spki' });
  if (derivedPublicKey.length !== trustedPublicKey.length || !timingSafeEqual(derivedPublicKey, trustedPublicKey)) {
    throw new Error('QUIZZER_RELEASE_PRIVATE_KEY does not match the public key embedded in Quizzer');
  }
  return true;
};
