import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

const ed25519Pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const seed = createHash('sha256').update('Quizzer Playwright release fixture; never use in production').digest();

export const releasePrivateKey = createPrivateKey({
  key: Buffer.concat([ed25519Pkcs8Prefix, seed]),
  format: 'der',
  type: 'pkcs8',
});

const publicKeyValue = createPublicKey(releasePrivateKey).export({ format: 'jwk' }).x;
if (!publicKeyValue) throw new Error('Could not create the Playwright release-signing fixture');
export const releasePublicKey: string = publicKeyValue;
