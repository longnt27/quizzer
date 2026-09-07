import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureServiceToken } from '../server/auth.mjs';

const webPort = Number(process.env.QUIZZER_E2E_WEB_PORT ?? 4174);
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error('QUIZZER_E2E_WEB_PORT must be a valid port');

const availablePort = () => new Promise((resolve, reject) => {
  const reservation = createServer();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const address = reservation.address();
    const port = typeof address === 'object' && address ? address.port : undefined;
    reservation.close(error => error ? reject(error) : resolve(port));
  });
});

const appDataDirectory = await mkdtemp(join(tmpdir(), 'quizzer-playwright-'));
const servicePort = await availablePort();
if (!servicePort) throw new Error('Could not reserve an isolated Quizzer service port');
const serviceToken = await ensureServiceToken(appDataDirectory);
const environment = {
  ...process.env,
  QUIZZER_APP_DATA_DIR: appDataDirectory,
  QUIZZER_DATABASE_PATH: join(appDataDirectory, 'quizzer.sqlite'),
  QUIZZER_SERVICE_PORT: String(servicePort),
  QUIZZER_API_TOKEN: serviceToken,
  VITE_QUIZZER_API_TOKEN: serviceToken,
  QUIZZER_DISABLE_SERVICE_GENERATION: '1',
  VITE_QUIZZER_RENDERER_WORKER: '1',
  QUIZZER_E2E_SEED_COST: process.env.QUIZZER_E2E_SEED_COST ?? '0',
};
Object.assign(process.env, environment);
if (environment.QUIZZER_E2E_SEED_COST === '1') await import('./e2e-seed-cost.mjs');
const children = [
  spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: environment }),
  spawn('npm', ['exec', '--', 'vite', '--host', '127.0.0.1', '--port', String(webPort)], { stdio: 'inherit', env: environment }),
];
let stopping = false;
const stop = signal => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

const result = await Promise.race(children.map(child => new Promise(resolve => {
  child.once('error', error => resolve({ code: 1, error }));
  child.once('exit', code => resolve({ code: typeof code === 'number' ? code : 1 }));
})));
stop('SIGTERM');
await Promise.all(children.map(child => child.exitCode === null
  ? new Promise(resolve => child.once('exit', resolve))
  : undefined));
await rm(appDataDirectory, { recursive: true, force: true });
if (result.error) process.stderr.write(`Could not start the Playwright application: ${result.error.message}\n`);
process.exitCode = result.code;
