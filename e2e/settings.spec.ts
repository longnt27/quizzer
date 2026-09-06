import { test, expect } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Settings search/reset and keyboard accessibility', async ({ page }) => {
  await dismissOnboarding(page);

  await setInterfaceMode(page, 'advanced');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Settings' });
  await expect(dialog.getByText('Settings', { exact: true })).toBeVisible();

  const search = dialog.getByLabel('Search settings');
  await search.fill('Generation concurrency');
  const concurrency = dialog.getByRole('spinbutton', { name: 'Generation concurrency' });
  await expect(concurrency).toBeVisible();
  await expect(dialog.getByText('Hardware profile', { exact: true })).toBeHidden();

  await concurrency.fill('7');
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Reset to selected profile' }).click();
  await expect(concurrency).toHaveValue('1');

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await dialog.getByLabel('Search settings').fill('Generation concurrency');
  await expect(dialog.getByRole('spinbutton', { name: 'Generation concurrency' })).toHaveValue('1');
});
