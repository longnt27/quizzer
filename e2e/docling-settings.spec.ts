import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const statusPayload = (doclingInstalled: boolean) => ({
  marker: { installed: true, managed: true, job: { state: 'idle', message: '' } },
  docling: {
    installed: doclingInstalled,
    managed: doclingInstalled,
    job: doclingInstalled
      ? { state: 'complete', message: 'Docling 2.126.0 and its local models are installed and ready.' }
      : { state: 'idle', message: '' },
  },
});

const openDocuments = async (page: Parameters<typeof dismissOnboarding>[0]) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Documents' }).click();
  const row = dialog.locator('.settings-row').filter({ hasText: 'Document extractor provider' });
  return { dialog, row, select: row.locator('.ant-select') };
};

test('Docling stays unavailable until its managed local runtime install is confirmed', async ({ page }) => {
  let installStarted = false;
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(statusPayload(false)),
  }));
  await page.route('**/api/integrations/docling/install', async route => {
    installStarted = true;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  const { dialog, select } = await openDocuments(page);
  await expect(select).not.toHaveClass(/ant-select-disabled/);
  await select.click();
  const unavailableDocling = page.locator('.ant-select-item-option').filter({ hasText: 'Docling (local)' });
  await expect(unavailableDocling).toHaveClass(/ant-select-item-option-disabled/);
  await page.keyboard.press('Escape');

  await expect(dialog.getByText(/Docling runs locally after a one-time managed install/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Install Docling' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm installation of Docling' });
  await expect(confirmation).toContainText('additional disk space on this device');
  expect(installStarted).toBe(false);
  await confirmation.getByRole('button', { name: 'Install' }).click();
  await expect.poll(() => installStarted).toBe(true);
});

test('installed Docling becomes selectable as a document extractor', async ({ page }) => {
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(statusPayload(true)),
  }));

  const { row, select } = await openDocuments(page);
  await select.click();
  const option = page.locator('.ant-select-item-option').filter({ hasText: 'Docling (local)' });
  await expect(option).not.toHaveClass(/ant-select-item-option-disabled/);
  await option.click();
  await expect(row.locator('.ant-select-selection-item')).toHaveText('Docling (local)');
});

test('Marker install failures remain visible in Document settings', async ({ page }) => {
  let installStarted = false;
  const failure = 'Marker installation failed: compatible Python 3.10+ not found.';

  await page.route('**/api/integrations', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        marker: installStarted
          ? { installed: false, managed: false, job: { state: 'error', message: failure } }
          : { installed: false, managed: false, job: { state: 'idle', message: '' } },
        docling: { installed: true, managed: true, job: { state: 'idle', message: '' } },
      }),
    });
  });
  await page.route('**/api/integrations/marker/install', async route => {
    installStarted = true;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Documents' }).click();

  await dialog.getByRole('button', { name: 'Install Marker' }).click();
  await expect(dialog.getByText(failure)).toBeVisible();
});
