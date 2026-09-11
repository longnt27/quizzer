import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Prompt Studio keeps the Settings modal width stable', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const before = await dialog.evaluate(element => (element as HTMLElement).offsetWidth);
  expect(before).toBeGreaterThan(0);

  await dialog.getByRole('tab', { name: 'Prompt Studio' }).click();
  await expect(dialog.getByRole('tabpanel', { name: 'Prompt Studio' })).toBeVisible();
  const after = await dialog.evaluate(element => (element as HTMLElement).offsetWidth);
  expect(after).toBe(before);
});
