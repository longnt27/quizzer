#!/usr/bin/env node
import { mergeReleaseArtifacts } from '../release/artifacts.mjs';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const result = await mergeReleaseArtifacts({ inputDirectory: flag('input') || 'downloaded-artifacts', outputDirectory: flag('output') || 'release-bundle' });
process.stdout.write(`Merged ${result.artifacts.length} release artifacts -> ${result.descriptorPath}\n`);
