import { test, expect } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Settings search/reset and keyboard accessibility', async ({ page }) => {
  await dismissOnboarding(page);

  await setInterfaceMode(page, 'advanced');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Settings' });
  await expect(dialog.getByText('Settings', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Overall' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  await expect(dialog.locator('.settings-row').filter({ hasText: 'Interface mode' }).getByText('Advanced', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Hardware profile' })).toBeVisible();
  await expect(dialog.getByText('Software Updates')).toBeVisible();

  await dialog.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('quizzer.theme'))).toBe('dark');

  await dialog.getByRole('tab', { name: 'Retrieval' }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Context budget' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Documents' }).click();
  await expect(dialog.getByRole('switch', { name: 'OCR' })).toBeVisible();

  const search = dialog.getByLabel('Search settings');
  await search.fill('Generation concurrency');
  await expect(dialog.getByRole('tab', { name: 'Generation' })).toHaveAttribute('aria-selected', 'true');
  const concurrency = dialog.getByRole('spinbutton', { name: 'Generation concurrency' });
  await expect(concurrency).toBeVisible();
  const selectedProfileConcurrency = await concurrency.inputValue();
  await expect(dialog.getByText('Hardware profile', { exact: true })).toBeHidden();

  await concurrency.fill('7');
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Reset to selected profile' }).click();
  await expect(concurrency).toHaveValue(selectedProfileConcurrency);

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await dialog.getByLabel('Search settings').fill('Generation concurrency');
  await expect(dialog.getByRole('spinbutton', { name: 'Generation concurrency' })).toHaveValue(selectedProfileConcurrency);
});
