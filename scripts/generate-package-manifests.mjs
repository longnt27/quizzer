#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generatePackageManifests } from '../release/package-manifests.mjs';

const ALLOWED_FLAGS = new Set([
  'manifest',
  'output',
  'private-key',
  'public-key',
  'public-key-id',
  'package-identifier',
  'package-name',
  'publisher',
  'cask-name',
]);

const args = process.argv.slice(2);
const flags = new Map();

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith('--')) {
    throw new Error(`Unexpected positional argument: ${arg}`);
  }
  const flagName = arg.slice(2);
  if (!ALLOWED_FLAGS.has(flagName)) {
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
    throw new Error(`Flag ${arg} requires a value`);
  }
  flags.set(flagName, args[++i]);
}

const manifestPath = resolve(flags.get('manifest') || 'release-bundle/release-manifest.json');
const outputDirectory = resolve(flags.get('output') || 'release-bundle');

let publicKeyPem = process.env.QUIZZER_RELEASE_PUBLIC_KEY;
if (flags.has('public-key')) {
  const publicKeyPath = resolve(flags.get('public-key'));
  publicKeyPem = await readFile(publicKeyPath, 'utf8');
}

const result = await generatePackageManifests({
  manifestPath,
  outputDirectory,
  privateKeyBase64: flags.get('private-key') || process.env.QUIZZER_RELEASE_PRIVATE_KEY,
  publicKeyPem,
  expectedPublicKeyId: flags.get('public-key-id') || process.env.QUIZZER_RELEASE_PUBLIC_KEY_ID,
  packageIdentifier: flags.get('package-identifier') || 'Somethings1.Quizzer',
  packageName: flags.get('package-name') || 'Quizzer',
  publisher: flags.get('publisher') || 'Quizzer contributors',
  caskName: flags.get('cask-name') || 'quizzer',
});

process.stdout.write(`Generated package manager manifests -> ${result.files.cask}, ${result.files.wingetVersion}, ${result.files.wingetInstaller}, ${result.files.wingetLocale}\n`);
