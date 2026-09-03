import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const tailscaleAddress = () => {
  try {
    const address = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(value => value.trim()).find(Boolean);
    if (address) return address;
  } catch { /* Fall back to the operating system's network interfaces. */ }
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find(item => item.family === 'IPv4' && item.address.startsWith('100.'));
    if (address) return address.address;
  }
};

const address = tailscaleAddress();
if (!address) {
  process.stderr.write('No Tailscale IPv4 address was found. Connect Tailscale, then try again.\n');
  process.exit(1);
}

if (!existsSync('node_modules')) {
  process.stdout.write('Installing Quizzer dependencies…\n');
  const install = spawnSync(npm, ['ci', '--legacy-peer-deps'], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const children = [
  spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: process.env }),
  spawn(npm, ['exec', '--', 'vite', '--host', address], { stdio: 'inherit', env: process.env }),
];

process.stdout.write(`\nQuizzer will be available on your Tailscale network at:\nhttp://${address}:5173/\n\nPress Control-C to stop Quizzer.\n\n`);

const stop = signal => children.forEach(child => { if (!child.killed) child.kill(signal); });
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

Promise.race(children.map(child => new Promise(resolve => child.on('exit', resolve)))).then(code => {
  stop('SIGTERM');
  process.exit(typeof code === 'number' ? code : 0);
});
