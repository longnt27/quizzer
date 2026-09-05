import { spawn } from 'node:child_process';

const vite = spawn('npm', ['exec', '--', 'vite'], { stdio: 'inherit', env: process.env });
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
    env: { ...process.env, QUIZZER_RENDERER_URL: 'http://127.0.0.1:5173/' },
  });
  electron.on('exit', code => { stop('SIGTERM'); process.exit(typeof code === 'number' ? code : 0); });
} catch (error) {
  stop('SIGTERM');
  throw error;
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
