import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('document extraction survives modal close and appears in Activity', async ({ page }) => {
  let releaseExtraction: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseExtraction = resolve; });
  await page.route('**/api/extract', async route => {
    await gate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ content: 'Persisted extraction content', parserVersion: 'test-extractor' }),
    });
  });

  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Add documents' }).last().click();
  let dialog = page.getByRole('dialog', { name: 'Add documents' });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'persistent.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Fallback content'),
  });
  await expect(dialog.getByText('Extracting', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const activityButton = page.locator('.sidebar-footer:visible').getByRole('button', { name: /job active/i });
  await expect(activityButton).toBeVisible();
  await activityButton.click();
  const activity = page.getByRole('dialog', { name: 'Activity' });
  await activity.getByRole('tab', { name: 'Document indexing' }).click();
  await expect(activity.getByText('Extract persistent')).toBeVisible();
  await expect(activity.getByText('Document extraction · survives closing Add documents')).toBeVisible();
  await activity.getByRole('button', { name: 'Close' }).click();

  releaseExtraction?.();

  await page.getByRole('button', { name: 'Add documents' }).last().click();
  dialog = page.getByRole('dialog', { name: 'Add documents' });
  await expect(dialog.locator('input[value="persistent"]')).toBeVisible();
  await expect(dialog.getByText('ready', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add to library' })).toBeVisible();
});
