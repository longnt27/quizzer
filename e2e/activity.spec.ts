import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('activity is a monitoring-only view', async ({ page }) => {
  await dismissOnboarding(page);
  await expect(page.locator('.generation-activity')).toHaveCount(0);
  await page.locator('.desktop-sidebar').getByRole('button', { name: 'Activity', exact: true }).click();

  const activity = page.getByRole('dialog', { name: 'Activity' });
  await expect(activity).toBeVisible();
  await expect(activity.getByRole('heading', { name: 'Quiz generation' })).toBeVisible();
  await expect(activity.getByRole('heading', { name: 'Document indexing' })).toBeVisible();
  await expect(activity.getByRole('slider')).toHaveCount(0);
  await expect(activity.getByText('Background work survives reloads and connection interruptions')).toHaveCount(0);
});
