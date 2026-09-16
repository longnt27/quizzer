import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Docling stays unavailable until its managed local runtime is installed', async ({ page }) => {
  let installStarted = false;
  let statusReadsAfterInstall = 0;

  await page.route('**/api/integrations', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const installed = installStarted && statusReadsAfterInstall++ >= 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        marker: { installed: true, managed: true, job: { state: 'idle', message: '' } },
        docling: {
          installed,
          managed: installed,
          job: installed
            ? { state: 'complete', message: 'Docling 2.126.0 and its local models are installed and ready.' }
            : installStarted
              ? { state: 'working', message: 'Downloading Docling models into Quizzer’s private environment…' }
              : { state: 'idle', message: '' },
        },
      }),
    });
  });
  await page.route('**/api/integrations/docling/install', async route => {
    installStarted = true;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Documents' }).click();

  const extractorRow = dialog.locator('.settings-row').filter({ hasText: 'Document extractor provider' });
  const extractorSelect = extractorRow.locator('.ant-select');
  await expect(extractorSelect).not.toHaveClass(/ant-select-disabled/);
  await extractorSelect.click();
  const unavailableDocling = page.locator('.ant-select-item-option').filter({ hasText: 'Docling (local)' });
  await expect(unavailableDocling).toHaveClass(/ant-select-item-option-disabled/);
  await page.keyboard.press('Escape');

  await expect(dialog.getByText(/Docling runs locally after a one-time managed install/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Install Docling' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm installation of Docling' });
  await expect(confirmation).toContainText('additional disk space on this device');
  expect(installStarted).toBe(false);
  await confirmation.getByRole('button', { name: 'Install' }).click();
  await expect(dialog.getByText(/Downloading Docling models/i)).toBeVisible();
  await expect(dialog.getByText(/Docling 2\.126\.0 and its local models are installed and ready/i)).toBeVisible();

  await extractorSelect.click();
  const option = page.locator('.ant-select-item-option').filter({ hasText: 'Docling (local)' });
  await expect(option).not.toHaveClass(/ant-select-item-option-disabled/);
  await option.click();
  await expect(extractorRow.locator('.ant-select-selection-item')).toHaveText('Docling (local)');
});
