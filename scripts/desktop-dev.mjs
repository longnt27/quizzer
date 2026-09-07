import { spawn } from 'node:child_process';
import { defaultAppDataDirectory } from '../server/paths.mjs';
import { authenticatedRuntimeEnvironment } from './runtime.mjs';

const userDataDirectory = process.env.QUIZZER_USER_DATA_DIR
  || process.env.QUIZZER_APP_DATA_DIR
  || defaultAppDataDirectory();
const environment = await authenticatedRuntimeEnvironment({
  ...process.env,
  QUIZZER_APP_DATA_DIR: userDataDirectory,
  QUIZZER_USER_DATA_DIR: userDataDirectory,
  QUIZZER_SERVICE_PORT: '8787',
});

const vite = spawn('npm', ['exec', '--', 'vite'], { stdio: 'inherit', env: environment });
const service = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: environment });
let electron;
let stopping = false;

const waitForUrl = async (url, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Process is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not start within 30 seconds`);
};

const stop = signal => {
  if (stopping) return;
  stopping = true;
  vite.kill(signal);
  service.kill(signal);
  electron?.kill(signal);
};

try {
  await Promise.all([
    waitForUrl('http://127.0.0.1:5173/', 'Vite'),
    waitForUrl('http://127.0.0.1:8787/api/health', 'Quizzer service'),
  ]);
  electron = spawn('npm', ['exec', '--', 'electron', '.'], {
    stdio: 'inherit',
    env: {
      ...environment,
      QUIZZER_RENDERER_URL: 'http://127.0.0.1:5173/',
      QUIZZER_EXTERNAL_SERVICE_PORT: '8787',
    },
  });
  electron.on('exit', code => { stop('SIGTERM'); process.exit(typeof code === 'number' ? code : 0); });
  service.on('exit', code => {
    if (electron && !stopping) {
      process.stderr.write(`Quizzer development service stopped (${code})\n`);
      stop('SIGTERM');
    }
  });
} catch (error) {
  stop('SIGTERM');
  throw error;
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
