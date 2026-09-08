import { defineConfig, devices } from '@playwright/test';

const port = 4175;

export default defineConfig({
  testDir: './e2e',
  testMatch: /readme-screenshots\.capture\.ts/,
  timeout: 180_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1050 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'node scripts/e2e-dev.mjs',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, QUIZZER_E2E_WEB_PORT: String(port) },
  },
});
