import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Prompt Studio keeps the Settings modal width stable', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const before = await dialog.boundingBox();
  expect(before).not.toBeNull();

  await dialog.getByRole('tab', { name: 'Prompt Studio' }).click();
  await expect(dialog.getByRole('tabpanel', { name: 'Prompt Studio' })).toBeVisible();
  const after = await dialog.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);
});
