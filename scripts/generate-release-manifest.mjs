#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { buildReleaseManifest, privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = name => {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const version = required('version').replace(/^v/, '');
const channel = required('channel');
const descriptorPath = required('artifacts');
const outputPath = flag('output') || 'release-manifest.json';
const repository = flag('repository') || process.env.GITHUB_REPOSITORY || 'Somethings1/quizzer';
const tag = flag('tag') || `v${version}`;
const publicKeyId = flag('public-key-id') || process.env.QUIZZER_RELEASE_PUBLIC_KEY_ID;
if (!publicKeyId) throw new Error('--public-key-id or QUIZZER_RELEASE_PUBLIC_KEY_ID is required');
if (channel !== 'stable' && channel !== 'beta') throw new Error('--channel must be stable or beta');

const artifacts = JSON.parse(await readFile(descriptorPath, 'utf8'));
if (!Array.isArray(artifacts) || !artifacts.length) throw new Error('Artifact descriptor must be a non-empty JSON array');
const manifest = await buildReleaseManifest({
  version,
  channel,
  publicKeyId,
  releaseUrl: `https://github.com/${repository}/releases/download/${tag}`,
  artifacts,
});
const signed = signReleaseManifest(manifest, privateKeyFromBase64(process.env.QUIZZER_RELEASE_PRIVATE_KEY));
await writeFile(outputPath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Signed ${signed.artifacts.length} artifacts for ${tag} -> ${outputPath}\n`);
