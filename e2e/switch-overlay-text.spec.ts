import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('Settings switches do not render On or Off overlay text', async ({ page }) => {
  await dismissOnboarding(page);
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Advanced' }).click();
  const switches = dialog.locator('.ant-switch');
  await expect(switches.first()).toBeVisible();
  await expect(switches.filter({ hasText: /^(On|Off)$/ })).toHaveCount(0);
});
