import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('exposes semantic main navigation and keyboard-accessible settings after onboarding', async ({ page }) => {
  await dismissOnboarding(page);
  const shell = page.locator('.app-shell');
  await expect(shell).toBeVisible({ timeout: 15_000 });

  const navigation = page.locator('.desktop-sidebar');
  await expect(navigation).toBeVisible();
  await expect(navigation.locator('button').filter({ hasText: 'Home' })).toHaveCount(0);
  const navigationItems = [
    navigation.locator('[role="tab"]').filter({ hasText: 'Documents' }),
    navigation.locator('[role="tab"]').filter({ hasText: 'Tests' }),
    navigation.locator('button').filter({ hasText: 'Activity' }),
    navigation.locator('button').filter({ hasText: 'Settings' }),
  ];
  for (const item of navigationItems) {
    await expect(item).toBeVisible();
    await item.focus();
    await expect(item).toBeFocused();
  }

  await navigation.locator('button').filter({ hasText: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const search = settings.getByRole('textbox', { name: 'Search settings' });
  await expect(settings.getByRole('radiogroup', { name: 'Interface mode' })).toBeVisible();
  await search.focus();
  await expect(search).toBeFocused();
});
