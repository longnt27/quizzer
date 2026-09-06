import { test, expect } from '@playwright/test';
import { bypassOnboarding } from './helpers';

test.use({ viewport: { width: 375, height: 667 } });

test('mobile-width workflow', async ({ page }) => {
  await bypassOnboarding(page);

  // Assert that mobile header is visible
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  
  // Assert sidebar is hidden
  const sidebar = page.locator('.app-shell > aside'); // desktop sidebar
  await expect(sidebar).toBeHidden();

  // Open drawer
  await page.getByRole('button', { name: 'Open navigation' }).click();
  
  // Now sidebar inside drawer should be visible
  await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible();

  // Try creating a test from mobile
  await page.getByRole('button', { name: 'Create test' }).first().click();
  await expect(page.getByText('Create tests from documents')).toBeVisible(); // modal title?
  // We just verify the modal opens
});
