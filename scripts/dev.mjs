import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: process.env }),
  spawn('npm', ['exec', '--', 'vite'], { stdio: 'inherit', env: process.env }),
];

const stop = signal => {
  for (const child of children) child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

Promise.race(children.map(child => new Promise(resolve => child.on('exit', resolve)))).then(code => {
  stop('SIGTERM');
  process.exit(typeof code === 'number' ? code : 0);
});
