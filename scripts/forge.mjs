import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = process.argv[2];
if (!['package', 'make'].includes(command)) {
  throw new Error('Usage: node scripts/forge.mjs <package|make>');
}

// Electron's bundled V8 defines the required C++ language level. A shell-level
// CXXFLAGS value can override it and make otherwise supported native addons fail.
const environment = { ...process.env };
delete environment.CXXFLAGS;

const forgeCli = fileURLToPath(new URL('../node_modules/@electron-forge/cli/dist/electron-forge.js', import.meta.url));
const child = spawn(process.execPath, [forgeCli, command, ...process.argv.slice(3)], {
  env: environment,
  stdio: 'inherit',
});

child.on('error', error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = typeof code === 'number' ? code : 1;
  if (signal) process.stderr.write(`Electron Forge stopped by ${signal}\n`);
});
