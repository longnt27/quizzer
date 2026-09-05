import { createHash, createPrivateKey, sign, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { validateReleaseManifest } from '../server/release-manifest.mjs';

export const canonicalizeManifest = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalizeManifest).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([key]) => key !== 'signature').sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeManifest(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex');

export const describeArtifact = async (descriptor, releaseUrl) => {
  if (!descriptor || typeof descriptor.path !== 'string') throw new Error('Every artifact descriptor requires a path');
  const name = descriptor.name || basename(descriptor.path);
  const details = await stat(descriptor.path);
  if (!details.isFile()) throw new Error(`Release artifact is not a file: ${descriptor.path}`);
  return {
    name,
    platform: descriptor.platform,
    architecture: descriptor.architecture,
    format: descriptor.format,
    url: `${releaseUrl.replace(/\/$/, '')}/${encodeURIComponent(name)}`,
    size: details.size,
    sha256: await sha256File(descriptor.path),
    minimumOs: descriptor.minimumOs,
    ...(descriptor.cli === true ? { cli: true } : {}),
  };
};

export const buildReleaseManifest = async ({ version, channel, publishedAt = new Date().toISOString(), publicKeyId, releaseUrl, artifacts }) => {
  const manifest = {
    schemaVersion: 1,
    version,
    channel,
    publishedAt,
    signatureAlgorithm: 'ed25519',
    publicKeyId,
    signature: '',
    artifacts: await Promise.all(artifacts.map(artifact => describeArtifact(artifact, releaseUrl))),
  };
  return manifest;
};

export const privateKeyFromBase64 = value => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('QUIZZER_RELEASE_PRIVATE_KEY must contain a base64 PKCS#8 Ed25519 private key');
  return createPrivateKey({ key: Buffer.from(value.trim(), 'base64'), format: 'der', type: 'pkcs8' });
};

export const signReleaseManifest = (manifest, privateKey) => {
  const signature = sign(null, Buffer.from(canonicalizeManifest(manifest)), privateKey).toString('base64url');
  const signed = { ...manifest, signature };
  const validation = validateReleaseManifest(signed);
  if (!validation.valid) throw new Error(`Generated release manifest is invalid: ${validation.errors.join('; ')}`);
  return signed;
};

export const verifyReleaseManifestSignature = (manifest, publicKey) => verify(
  null,
  Buffer.from(canonicalizeManifest(manifest)),
  publicKey,
  Buffer.from(manifest.signature, 'base64url'),
);
