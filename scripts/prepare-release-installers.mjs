#!/usr/bin/env node
import { resolve } from 'node:path';
import { prepareReleaseInstallers } from '../release/installers.mjs';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const projectDirectory = resolve(import.meta.dirname, '..');
const manifestPath = resolve(flag('manifest') || 'release-bundle/release-manifest.json');
const outputDirectory = resolve(flag('output') || 'release-bundle');
const result = await prepareReleaseInstallers({
  manifestPath,
  privateKeyBase64: process.env.QUIZZER_RELEASE_PRIVATE_KEY,
  outputDirectory,
  shellTemplatePath: resolve(projectDirectory, 'installers', 'install.sh.in'),
  powershellTemplatePath: resolve(projectDirectory, 'installers', 'install.ps1.in'),
});
process.stdout.write(`Prepared signed metadata and installers -> ${result.shell}, ${result.powershell}\n`);
