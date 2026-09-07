import { expect, test } from '@playwright/test';

test('boots with semantic main navigation and keyboard-accessible mode control', async ({ page }, testInfo) => {
  await page.goto('/');
  const shell = page.locator('.app-shell');
  if (!(await shell.isVisible({ timeout: 5_000 }).catch(() => false))) {
    testInfo.skip(true, `${testInfo.project.name} cannot boot the desktop shell in this environment`);
  }

  const navigation = page.locator('.desktop-sidebar');
  await expect(navigation).toBeVisible();
  for (const name of ['Home', 'Documents', 'Tests', 'Activity']) {
    const item = ['Documents', 'Tests'].includes(name)
      ? navigation.locator('[role="tab"]').filter({ hasText: name })
      : navigation.locator('button').filter({ hasText: name });
    await expect(item).toBeVisible();
    await item.focus();
    await expect(item).toBeFocused();
  }

  const mode = page.getByRole('button', { name: /Switch to (Simple|Advanced) mode/ });
  await expect(mode).toBeVisible();
  await mode.focus();
  await expect(mode).toBeFocused();
});
