import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { authenticatedRuntimeEnvironment, superviseChildren } from './runtime.mjs';
import { findTailscaleAddress } from './tailscale-address.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const address = findTailscaleAddress();
if (!address) {
  process.stderr.write('No Tailscale IPv4 address was found. Connect Tailscale, then try again.\n');
  process.exit(1);
}

if (!existsSync('node_modules')) {
  process.stdout.write('Installing Quizzer dependencies…\n');
  const install = spawnSync(npm, ['ci', '--legacy-peer-deps'], { stdio: 'inherit' });
  if (install.error) {
    process.stderr.write(`Could not install Quizzer dependencies: ${install.error.message}\n`);
    process.exit(1);
  }
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const environment = await authenticatedRuntimeEnvironment();

const children = [
  // The service always binds to loopback; only the Vite proxy is tailnet-visible.
  spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: environment }),
  spawn(npm, ['exec', '--', 'vite', '--host', address, '--strictPort'], { stdio: 'inherit', env: environment }),
];

process.stdout.write(`\nQuizzer will be available on your Tailscale network at:\nhttp://${address}:5173/\n\nPress Control-C to stop Quizzer.\n\n`);

const result = await superviseChildren(children);
if (result.error) process.stderr.write(`Quizzer Tailscale process failed: ${result.error.message}\n`);
process.exitCode = result.code;
