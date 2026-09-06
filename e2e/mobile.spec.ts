import { test, expect } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test.use({ viewport: { width: 375, height: 667 } });

test('mobile-width workflow', async ({ page }) => {
  await dismissOnboarding(page);

  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(page.locator('.desktop-sidebar')).toBeHidden();

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.locator('.ant-drawer-content:not(.onboarding-drawer)');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Settings' })).toBeVisible();

  await drawer.getByRole('button', { name: 'Create test' }).click();
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Create tests from documents' });
  await expect(dialog.getByText('Create tests from documents')).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await drawer.getByRole('tab', { name: 'Documents' }).click();
  await drawer.getByRole('button', { name: 'Add documents' }).click();
  const addDocuments = page.locator('.ant-modal-content').filter({ hasText: 'Add documents' });
  await expect(addDocuments.getByText('Add documents', { exact: true })).toBeVisible();
});
