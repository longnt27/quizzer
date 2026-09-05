import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensureServiceToken } from '../server/auth.mjs';

const appDataDirectory = process.env.QUIZZER_APP_DATA_DIR || join(process.cwd(), '.quizzer-data');
const serviceToken = await ensureServiceToken(appDataDirectory);
const environment = {
  ...process.env,
  QUIZZER_APP_DATA_DIR: appDataDirectory,
  QUIZZER_DATABASE_PATH: process.env.QUIZZER_DATABASE_PATH || join(appDataDirectory, 'quizzer.sqlite'),
  QUIZZER_API_TOKEN: serviceToken,
  VITE_QUIZZER_API_TOKEN: serviceToken,
};

const children = [
  spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: environment }),
  spawn('npm', ['exec', '--', 'vite'], { stdio: 'inherit', env: environment }),
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
