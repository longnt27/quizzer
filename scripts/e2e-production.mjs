import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const port = Number(process.env.QUIZZER_E2E_PRODUCTION_PORT ?? 4175);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('QUIZZER_E2E_PRODUCTION_PORT must be a valid port');
}

const appDataDirectory = await mkdtemp(join(tmpdir(), 'quizzer-production-playwright-'));
const { QUIZZER_API_TOKEN: _serviceToken, VITE_QUIZZER_API_TOKEN: _rendererToken, ...baseEnvironment } = process.env;
const environment = {
  ...baseEnvironment,
  QUIZZER_APP_DATA_DIR: appDataDirectory,
  QUIZZER_DATABASE_PATH: join(appDataDirectory, 'quizzer.sqlite'),
  QUIZZER_SERVICE_PORT: String(port),
  QUIZZER_WEB_ROOT: resolve('dist'),
  QUIZZER_DISABLE_SERVICE_GENERATION: '1',
};

const service = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: environment });
let stopping = false;
const stop = signal => {
  if (stopping) return;
  stopping = true;
  if (!service.killed) service.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

const result = await new Promise(resolve => {
  service.once('error', error => resolve({ code: 1, error }));
  service.once('exit', code => resolve({ code: typeof code === 'number' ? code : 1 }));
});
await rm(appDataDirectory, { recursive: true, force: true });
if (result.error) process.stderr.write(`Could not start the production Quizzer service: ${result.error.message}\n`);
process.exitCode = result.code;
