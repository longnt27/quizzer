#!/usr/bin/env node
import { resolve } from 'node:path';
import { generatePackageManifests } from '../release/package-manifests.mjs';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const manifestPath = resolve(flag('manifest') || 'release-bundle/release-manifest.json');
const outputDirectory = resolve(flag('output') || 'release-bundle');

const result = await generatePackageManifests({
  manifestPath,
  outputDirectory,
  privateKeyBase64: flag('private-key') || process.env.QUIZZER_RELEASE_PRIVATE_KEY,
  publicKeyPem: flag('public-key') || process.env.QUIZZER_RELEASE_PUBLIC_KEY,
  expectedPublicKeyId: flag('public-key-id') || process.env.QUIZZER_RELEASE_PUBLIC_KEY_ID,
  packageIdentifier: flag('package-identifier') || 'Quizzer.Quizzer',
  packageName: flag('package-name') || 'Quizzer',
  publisher: flag('publisher') || 'Quizzer contributors',
  caskName: flag('cask-name') || 'quizzer',
});

process.stdout.write(`Generated package manager manifests -> ${result.files.cask}, ${result.files.wingetVersion}, ${result.files.wingetInstaller}, ${result.files.wingetLocale}\n`);
