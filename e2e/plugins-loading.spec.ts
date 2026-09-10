import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Plugins & models preloads once and only re-detects on manual refresh', async ({ page }) => {
  let integrationLoads = 0;
  let pluginLoads = 0;

  await page.route('**/api/integrations', async route => {
    integrationLoads += 1;
    await route.continue();
  });
  await page.route('**/api/v1/plugins', async route => {
    if (!route.request().url().includes('registry')) pluginLoads += 1;
    await route.continue();
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');

  await expect.poll(() => integrationLoads).toBe(1);
  await expect.poll(() => pluginLoads).toBe(1);

  await page.getByRole('button', { name: 'Configure AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Configure AI' }).click();
  await expect(dialog).toBeVisible();
  expect(integrationLoads).toBe(1);
  expect(pluginLoads).toBe(1);

  await dialog.getByRole('button', { name: 'Detect plugins and models again' }).click();
  await expect.poll(() => integrationLoads).toBe(2);
  await expect.poll(() => pluginLoads).toBe(2);
});
