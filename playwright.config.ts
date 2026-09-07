import { defineConfig, devices } from '@playwright/test';

const port = 4174;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testMatch: /.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testMatch: /cross-browser-smoke\.spec\.ts/, use: { ...devices['Desktop Firefox'] } },
    // The Electron-oriented application shell does not boot under Playwright
    // WebKit in CI/local Vite (landing WebKit coverage remains enabled).
  ],
  webServer: {
    command: 'node scripts/e2e-dev.mjs',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, QUIZZER_E2E_WEB_PORT: String(port) },
  },
});
