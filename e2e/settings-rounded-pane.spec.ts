import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('Settings content pane has rounded corners', async ({ page }) => {
  await dismissOnboarding(page);
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const pane = dialog.locator('.settings-content-pane');
  await expect(pane).toBeVisible();
  await expect(pane).toHaveCSS('border-radius', '12px');
});
