import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

const installUpdaterStub = async (page: import('@playwright/test').Page, outcome: 'available' | 'current' | 'error') => {
  await page.addInitScript(selectedOutcome => {
    const calls = { check: 0, status: 0, download: 0, apply: 0 };
    const status = {
      state: selectedOutcome === 'available' ? 'available' : 'up-to-date',
      currentVersion: '1.0.0-beta.5',
      channel: 'beta',
      target: { platform: 'darwin', architecture: 'arm64' },
      keyStatus: { configured: true, trusted: true, id: 'test-key', algorithm: 'Ed25519' },
      mechanism: 'staged-ready',
      supported: true,
      updateInfo: selectedOutcome === 'available' ? {
        version: '1.0.0-beta.6',
        channel: 'beta',
        publishedAt: '2026-09-08T00:00:00.000Z',
        publicKeyId: 'test-key',
        artifact: {
          name: 'Quizzer.pkg', platform: 'darwin', architecture: 'arm64', format: 'pkg',
          url: 'https://github.com/longnt27/quizzer/releases/download/v1.0.0-beta.6/Quizzer.pkg',
          size: 1024, sha256: 'a'.repeat(64),
        },
      } : undefined,
    };
    Object.assign(window, { __startupUpdaterCalls: calls });
    Object.defineProperty(window, 'quizzerDesktop', {
      configurable: true,
      value: { updater: {
        getStatus: async () => { calls.status += 1; return status; },
        checkForUpdates: async () => {
          calls.check += 1;
          if (selectedOutcome === 'error') throw new Error('offline');
          return status;
        },
        downloadUpdate: async () => { calls.download += 1; return status; },
        applyUpdate: async () => { calls.apply += 1; throw new Error('not used'); },
        discardUpdate: async () => ({ discarded: true, status }),
        rollbackUpdate: async () => { throw new Error('not used'); },
      } },
    });
  }, outcome);
};

const updaterCalls = (page: import('@playwright/test').Page) => page.evaluate(() => (
  window as Window & { __startupUpdaterCalls: { check: number; status: number; download: number; apply: number } }
).__startupUpdaterCalls);

test('notifies once for an available update and opens its Settings details without downloading', async ({ page }) => {
  await installUpdaterStub(page, 'available');
  await dismissOnboarding(page);

  const notice = page.locator('.ant-notification-notice').filter({ hasText: 'Quizzer 1.0.0-beta.6 is available' });
  await expect(notice).toHaveCount(1);
  await expect(notice.getByRole('status')).toBeVisible();
  await notice.getByRole('button', { name: 'Review update' }).click();

  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'Software Updates' })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.locator('.updater-status-card').getByText('Software Updates', { exact: true })).toBeVisible();
  await expect.poll(() => updaterCalls(page)).toMatchObject({ check: 1, download: 0, apply: 0 });

  await settings.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await dismissOnboarding(page, false);
  await expect(page.locator('.ant-notification-notice').filter({ hasText: 'is available' })).toHaveCount(0);
  await expect.poll(() => updaterCalls(page)).toMatchObject({ check: 0, download: 0, apply: 0 });
});

test('stays silent when the app is current or the startup check fails', async ({ browser }) => {
  for (const outcome of ['current', 'error'] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installUpdaterStub(page, outcome);
    await page.goto('/');
    await page.locator('.app-shell').waitFor();
    await expect.poll(async () => (await updaterCalls(page)).check).toBe(1);
    await expect(page.locator('.ant-notification-notice').filter({ hasText: 'is available' })).toHaveCount(0);
    await context.close();
  }
});
