import { validateReleaseSigningConfiguration } from '../release/trust.mjs';

validateReleaseSigningConfiguration({
  privateKeyBase64: process.env.QUIZZER_RELEASE_PRIVATE_KEY,
  publicKeyId: process.env.QUIZZER_RELEASE_PUBLIC_KEY_ID,
  publicKeyRawBase64: process.env.QUIZZER_RELEASE_PUBLIC_KEY,
});

process.stdout.write('Release signing key matches the public trust anchor embedded in Quizzer.\n');
