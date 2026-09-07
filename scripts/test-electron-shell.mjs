import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rebuild } from '@electron/rebuild';

const projectDirectory = process.cwd();
const electronPackage = JSON.parse(await readFile(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8'));

// The service is forked by Electron's Node runtime, so native addons must be
// built for Electron's ABI rather than the Node runtime used by npm scripts.
// Keep this local and deterministic: only the SQLite addon is rebuilt, and
// no provider or network process is started by this command.
const originalCxxFlags = process.env.CXXFLAGS;
delete process.env.CXXFLAGS;
try {
  await rebuild({
    buildPath: projectDirectory,
    electronVersion: electronPackage.version,
    projectRootPath: projectDirectory,
    onlyModules: ['better-sqlite3'],
    extraModules: [],
    force: true,
    buildFromSource: true,
  });
} finally {
  if (originalCxxFlags === undefined) delete process.env.CXXFLAGS;
  else process.env.CXXFLAGS = originalCxxFlags;
}

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: projectDirectory, stdio: 'inherit', env: process.env });
  child.once('error', reject);
  child.once('exit', code => {
    if (code === 0) resolve();
    else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'a signal'}`));
  });
});

await run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.electron.config.ts']);
