import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { terminationPlanForPlatform } from '../scripts/electron-shell-platform.mjs';

const executable = resolve(process.env.QUIZZER_PACKAGED_ELECTRON_EXECUTABLE || 'missing-packaged-electron-executable');

if (!process.env.QUIZZER_PACKAGED_ELECTRON_EXECUTABLE || !existsSync(executable)) {
  throw new Error(`Packaged Electron executable does not exist: ${executable}`);
}

const reserveLoopbackPort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => {
      if (error) reject(error);
      else if (!address || typeof address === 'string') reject(new Error('Could not reserve a packaged smoke-test port'));
      else resolvePort(address.port);
    });
  });
});

const waitForExit = (child, timeoutMs) => new Promise(resolveExit => {
  if (child.exitCode !== null || child.signalCode) return resolveExit(true);
  const timer = setTimeout(() => resolveExit(false), timeoutMs);
  child.once('exit', () => { clearTimeout(timer); resolveExit(true); });
});

const terminate = async (child, force = false) => {
  if (!child || child.exitCode !== null || child.signalCode || !child.pid) return;
  const plan = terminationPlanForPlatform({
    platform: process.platform,
    pid: child.pid,
    force,
    systemRoot: process.env.SystemRoot,
  });
  if (process.platform === 'win32') {
    await new Promise(resolveKill => {
      const killer = spawn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolveKill);
      killer.once('exit', resolveKill);
    });
  } else {
    try { process.kill(plan.processGroup, plan.signal); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
};

test.describe('Packaged Quizzer desktop shell', () => {
  let appProcess;
  let browser;
  let userDataDirectory;

  test.beforeEach(async () => {
    const debugPort = await reserveLoopbackPort();
    userDataDirectory = await mkdtemp(join(tmpdir(), 'quizzer-packaged-smoke-'));
    appProcess = spawn(executable, [
      '--disable-gpu',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`,
    ], {
      detached: process.platform !== 'win32',
      windowsHide: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        QUIZZER_USER_DATA_DIR: userDataDirectory,
        QUIZZER_APP_DATA_DIR: userDataDirectory,
        QUIZZER_DISABLE_SERVICE_GENERATION: '1',
        QUIZZER_SERVICE_PORT: '0',
        QUIZZER_RENDERER_URL: '',
        QUIZZER_EXTERNAL_SERVICE_PORT: '',
      },
    });
    appProcess.stdout.pipe(process.stdout);
    appProcess.stderr.pipe(process.stderr);
    await expect.poll(async () => {
      if (appProcess.exitCode !== null) return false;
      return fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.ok).catch(() => false);
    }, { timeout: 30_000, message: 'packaged Electron debugging endpoint should become ready' }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  });

  test.afterEach(async () => {
    await browser?.close().catch(() => {});
    await terminate(appProcess);
    if (appProcess && !await waitForExit(appProcess, 5_000)) {
      await terminate(appProcess, true);
      assert.equal(await waitForExit(appProcess, 5_000), true, 'packaged app must exit after forced termination');
    }
    if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true });
  });

  test('boots the fused app and serves the sandboxed custom-protocol renderer', async () => {
    await expect.poll(() => browser.contexts().flatMap(context => context.pages())
      .find(page => page.url() === 'quizzer://app/')?.url() ?? '', { timeout: 30_000 }).toBe('quizzer://app/');
    const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === 'quizzer://app/');
    assert.ok(page);
    await expect(page.getByRole('heading', { name: 'Welcome to Quizzer' })).toBeVisible();
    const rendererSurface = await page.evaluate(() => ({
      nodeIntegrationVisible: typeof process !== 'undefined' || typeof require !== 'undefined',
      desktopFrozen: Object.isFrozen(window.quizzerDesktop),
      ipcRendererVisible: 'ipcRenderer' in window,
      origin: window.location.origin,
    }));
    assert.deepEqual(rendererSurface, {
      nodeIntegrationVisible: false,
      desktopFrozen: true,
      ipcRendererVisible: false,
      origin: 'quizzer://app',
    });
  });
});
