import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const coverageRoots = ['server/*.mjs', 'plugin-sdk/*.mjs', 'release/*.mjs', 'desktop/updater.mjs', 'desktop/updater-ipc.mjs'];
const testFiles = (await readdir('test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name));

if (!testFiles.length) throw new Error('No test files were found');

const arguments_ = [
  '--test',
  '--experimental-test-coverage',
  ...coverageRoots.map(pattern => `--test-coverage-include=${pattern}`),
  '--test-coverage-lines=90',
  '--test-coverage-branches=80',
  ...testFiles,
];
const child = spawn(process.execPath, arguments_, { stdio: 'inherit' });

child.once('error', error => {
  process.stderr.write(`Could not start coverage tests: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.stderr.write(`Coverage tests stopped by ${signal}\n`);
  process.exitCode = typeof code === 'number' ? code : 1;
});
