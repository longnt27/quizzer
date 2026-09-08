import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('exposes semantic main navigation and keyboard-accessible mode control after onboarding', async ({ page }) => {
  await dismissOnboarding(page);
  const shell = page.locator('.app-shell');
  await expect(shell).toBeVisible({ timeout: 15_000 });

  const navigation = page.locator('.desktop-sidebar');
  await expect(navigation).toBeVisible();
  const navigationItems = [
    navigation.locator('button').filter({ hasText: 'Home' }),
    navigation.locator('[role="tab"]').filter({ hasText: 'Documents' }),
    navigation.locator('[role="tab"]').filter({ hasText: 'Tests' }),
    navigation.locator('button').filter({ hasText: 'Activity' }),
  ];
  for (const item of navigationItems) {
    await expect(item).toBeVisible();
    await item.focus();
    await expect(item).toBeFocused();
  }

  const mode = page.getByRole('button', { name: /Switch to (Simple|Advanced) mode/ });
  await expect(mode).toBeVisible();
  await mode.focus();
  await expect(mode).toBeFocused();
});
