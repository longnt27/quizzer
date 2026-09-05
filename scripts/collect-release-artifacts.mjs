#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { collectReleaseArtifacts } from '../release/artifacts.mjs';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const currentPlatform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
const result = await collectReleaseArtifacts({
  sourceDirectory: flag('source') || 'out/make',
  cliPath: flag('cli') || `out/cli/quizzer${process.platform === 'win32' ? '.exe' : ''}`,
  outputDirectory: flag('output') || 'release-artifacts',
  platform: flag('platform') || currentPlatform,
  architecture: flag('architecture') || process.arch,
  version: flag('version') || packageJson.version,
});
process.stdout.write(`Collected ${result.artifacts.length} release artifacts -> ${result.descriptorPath}\n`);
