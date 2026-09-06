import { test, expect } from '@playwright/test';
import { bypassOnboarding } from './helpers';

test('immediate reversible Simple/Advanced disclosure with stored data retained', async ({ page }) => {
  await bypassOnboarding(page);

  // Assert starting in Simple mode
  await expect(page.getByText('Switch to Advanced mode')).toBeVisible();

  // Test that Advanced disclosure appears immediately
  await page.getByText('Switch to Advanced mode').click();
  await expect(page.getByText('Switch to Simple mode')).toBeVisible();
  
  // Verify Advanced mode brings new capabilities (Prompt Studio)
  await expect(page.getByRole('button', { name: 'Prompt Studio' })).toBeVisible();

  // Reload page to verify state is retained
  await page.reload();
  await expect(page.getByText('Switch to Simple mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prompt Studio' })).toBeVisible();

  // Reversible
  await page.getByText('Switch to Simple mode').click();
  await expect(page.getByText('Switch to Advanced mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prompt Studio' })).toBeHidden();

  // Reload page to verify state is retained in Simple mode
  await page.reload();
  await expect(page.getByText('Switch to Advanced mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prompt Studio' })).toBeHidden();
});
