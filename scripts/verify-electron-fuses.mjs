import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FuseState, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { electronFuseConfig } from '../forge.config.mjs';

const defaultExecutable = () => {
  const packageDirectory = resolve('out', `Quizzer-${process.platform}-${process.arch}`);
  if (process.platform === 'darwin') return join(packageDirectory, 'Quizzer.app', 'Contents', 'MacOS', 'Quizzer');
  return join(packageDirectory, process.platform === 'win32' ? 'quizzer.exe' : 'quizzer');
};

const executable = resolve(process.argv[2] || defaultExecutable());
await access(executable);
const wire = await getCurrentFuseWire(executable);
if (wire.version !== FuseVersion.V1) throw new Error(`Unexpected Electron fuse version: ${wire.version}`);

const configuredFuseIndexes = Object.keys(electronFuseConfig).filter(key => /^\d+$/.test(key)).sort((left, right) => Number(left) - Number(right));
const emittedFuseIndexes = Object.keys(wire).filter(key => /^\d+$/.test(key)).sort((left, right) => Number(left) - Number(right));
if (JSON.stringify(emittedFuseIndexes) !== JSON.stringify(configuredFuseIndexes)) {
  throw new Error(`Packaged Electron fuse schema does not match the release policy: expected ${configuredFuseIndexes.join(', ')}, received ${emittedFuseIndexes.join(', ')}`);
}

for (const index of configuredFuseIndexes) {
  const expected = electronFuseConfig[index] ? FuseState.ENABLE : FuseState.DISABLE;
  if (wire[index] !== expected) throw new Error(`Electron fuse ${index} is ${wire[index]}, expected ${expected}`);
}
process.stdout.write(`Verified ${configuredFuseIndexes.length} Electron fuses in ${executable}\n`);
