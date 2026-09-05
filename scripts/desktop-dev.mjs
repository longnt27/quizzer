import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensureServiceToken } from '../server/auth.mjs';

const userDataDirectory = process.env.QUIZZER_USER_DATA_DIR || join(process.cwd(), '.quizzer-data', 'desktop');
const serviceToken = await ensureServiceToken(userDataDirectory);
const environment = {
  ...process.env,
  QUIZZER_USER_DATA_DIR: userDataDirectory,
  QUIZZER_APP_DATA_DIR: userDataDirectory,
  QUIZZER_API_TOKEN: serviceToken,
  VITE_QUIZZER_API_TOKEN: serviceToken,
};

const vite = spawn('npm', ['exec', '--', 'vite'], { stdio: 'inherit', env: environment });
let electron;

const waitForRenderer = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:5173/');
      if (response.ok) return;
    } catch { /* Renderer is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Vite did not start within 30 seconds');
};

const stop = signal => {
  vite.kill(signal);
  electron?.kill(signal);
};

try {
  await waitForRenderer();
  electron = spawn('npm', ['exec', '--', 'electron', '.'], {
    stdio: 'inherit',
    env: { ...environment, QUIZZER_RENDERER_URL: 'http://127.0.0.1:5173/' },
  });
  electron.on('exit', code => { stop('SIGTERM'); process.exit(typeof code === 'number' ? code : 0); });
} catch (error) {
  stop('SIGTERM');
  throw error;
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
