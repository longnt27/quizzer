#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { prepareAppImageRuntime, resolveTargetArchFromArgs } from '../release/appimage-runtime.mjs';

export { prepareAppImageRuntime, resolveTargetArchFromArgs };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const targetArch = resolveTargetArchFromArgs(process.argv.slice(2), process.arch);
  const runtimePath = await prepareAppImageRuntime({ architecture: targetArch });
  process.stdout.write(`Prepared AppImage runtime (${targetArch}) -> ${runtimePath}\n`);
}
