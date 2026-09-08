import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('exposes semantic main navigation and keyboard-accessible mode control after onboarding', async ({ page }) => {
  await dismissOnboarding(page);
  const shell = page.locator('.app-shell');
  await expect(shell).toBeVisible({ timeout: 15_000 });

  const navigation = page.locator('.desktop-sidebar');
  await expect(navigation).toBeVisible();
  const navigationItems = [
    navigation.getByRole('button', { name: 'Home', exact: true }),
    navigation.getByRole('tab', { name: 'Documents', exact: true }),
    navigation.getByRole('tab', { name: 'Tests', exact: true }),
    navigation.getByRole('button', { name: 'Activity', exact: true }),
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
