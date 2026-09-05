#!/usr/bin/env node
import { mergeDesktopArtifacts } from '../release/artifacts.mjs';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const result = await mergeDesktopArtifacts({ inputDirectory: flag('input') || 'downloaded-artifacts', outputDirectory: flag('output') || 'release-bundle' });
process.stdout.write(`Merged ${result.artifacts.length} desktop artifacts -> ${result.descriptorPath}\n`);
