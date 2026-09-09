import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

type Outcome = 'available' | 'current' | 'error';

const installUpdaterStub = async (
  page: import('@playwright/test').Page,
  outcome: Outcome,
  autoDownload = true,
) => {
  await page.addInitScript(({ selectedOutcome, automatic }) => {
    const calls = { check: 0, status: 0, download: 0, apply: 0, setAutoDownload: 0, restart: false };
    const updateInfo = selectedOutcome === 'available' ? {
      version: '1.0.0-beta.6',
      channel: 'beta',
      publishedAt: '2026-09-08T00:00:00.000Z',
      publicKeyId: 'test-key',
      artifact: {
        name: 'Quizzer.dmg', platform: 'macos', architecture: 'arm64', format: 'dmg',
        url: 'https://github.com/longnt27/quizzer/releases/download/v1.0.0-beta.6/Quizzer.dmg',
        size: 1024, sha256: 'a'.repeat(64),
      },
    } : undefined;
    let status = {
      state: 'idle',
      currentVersion: '1.0.0-beta.5',
      channel: 'beta',
      autoDownload: automatic,
      target: { platform: 'macos', architecture: 'arm64' },
      keyStatus: { configured: true, trusted: true, id: 'test-key', algorithm: 'Ed25519' },
      mechanism: 'staged-ready',
      supported: true,
      updateInfo: undefined,
    };
    Object.assign(window, { __startupUpdaterCalls: calls });
    Object.defineProperty(window, 'quizzerDesktop', {
      configurable: true,
      value: { updater: {
        getStatus: async () => { calls.status += 1; return status; },
        checkForUpdates: async () => {
          calls.check += 1;
          if (selectedOutcome === 'error') throw new Error('offline');
          status = { ...status, state: selectedOutcome === 'available' ? 'available' : 'up-to-date', updateInfo };
          return status;
        },
        downloadUpdate: async () => {
          calls.download += 1;
          status = { ...status, state: 'downloaded' };
          return status;
        },
        setAutoDownload: async (enabled: boolean) => {
          calls.setAutoDownload += 1;
          status = { ...status, autoDownload: enabled };
          return status;
        },
        applyUpdate: async (options?: { restart?: boolean }) => {
          calls.apply += 1;
          calls.restart = options?.restart === true;
          return {
            applied: false,
            handoffPending: true,
            restartRequested: calls.restart,
            mechanism: 'staged-ready',
            message: 'Installing',
            status,
          };
        },
        discardUpdate: async () => ({ discarded: true, status }),
        rollbackUpdate: async () => { throw new Error('not used'); },
      } },
    });
  }, { selectedOutcome: outcome, automatic: autoDownload });
};

const updaterCalls = (page: import('@playwright/test').Page) => page.evaluate(() => (
  window as Window & { __startupUpdaterCalls: {
    check: number;
    status: number;
    download: number;
    apply: number;
    setAutoDownload: number;
    restart: boolean;
  } }
).__startupUpdaterCalls);

test('downloads an available update automatically and installs it with one restart click', async ({ page }) => {
  await installUpdaterStub(page, 'available');
  await dismissOnboarding(page);

  const notice = page.locator('.ant-notification-notice').filter({ hasText: 'Quizzer 1.0.0-beta.6 is ready to install' });
  await expect(notice).toHaveCount(1);
  await expect(notice.getByRole('status')).toBeVisible();
  await expect.poll(() => updaterCalls(page)).toMatchObject({ check: 1, status: 1, download: 1, apply: 0 });

  await notice.getByRole('button', { name: 'Install and restart' }).click();
  await expect.poll(() => updaterCalls(page)).toMatchObject({ apply: 1, restart: true });

  await page.reload();
  await dismissOnboarding(page, false);
  await expect(page.locator('.ant-notification-notice').filter({ hasText: 'ready to install' })).toHaveCount(0);
  await expect.poll(() => updaterCalls(page)).toMatchObject({ check: 0, status: 0, download: 0, apply: 0 });
});

test('offers a manual download when automatic downloads are disabled', async ({ page }) => {
  await installUpdaterStub(page, 'available', false);
  await dismissOnboarding(page);

  const available = page.locator('.ant-notification-notice').filter({ hasText: 'Quizzer 1.0.0-beta.6 is available' });
  await expect(available).toHaveCount(1);
  await expect.poll(() => updaterCalls(page)).toMatchObject({ check: 1, download: 0 });
  await available.getByRole('button', { name: 'Download update' }).click();

  const ready = page.locator('.ant-notification-notice').filter({ hasText: 'Quizzer 1.0.0-beta.6 is ready to install' });
  await expect(ready).toHaveCount(1);
  await expect.poll(() => updaterCalls(page)).toMatchObject({ download: 1, apply: 0 });
});

test('stays silent when the app is current or the startup check fails', async ({ browser }) => {
  for (const outcome of ['current', 'error'] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installUpdaterStub(page, outcome);
    await page.goto('/');
    await page.locator('.app-shell').waitFor();
    await expect.poll(async () => (await updaterCalls(page)).check).toBe(1);
    await expect(page.locator('.ant-notification-notice').filter({ hasText: /is available|ready to install/ })).toHaveCount(0);
    await context.close();
  }
});
