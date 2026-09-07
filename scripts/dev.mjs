import { spawn } from 'node:child_process';
import { authenticatedRuntimeEnvironment, superviseChildren } from './runtime.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const environment = await authenticatedRuntimeEnvironment();

const children = [
  spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: environment }),
  spawn(npm, ['exec', '--', 'vite'], { stdio: 'inherit', env: environment }),
];

const result = await superviseChildren(children);
if (result.error) process.stderr.write(`Quizzer development process failed: ${result.error.message}\n`);
process.exitCode = result.code;
