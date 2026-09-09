import { expect, type Page } from '@playwright/test';

export async function dismissOnboarding(page: Page, navigate = true) {
  if (navigate) await page.goto('/');
  await page.locator('.app-shell').waitFor();
  const welcome = page.getByRole('heading', { name: 'Welcome to Quizzer' });
  const pause = page.getByRole('button', { name: 'Pause' });
  const onboarding = page.locator('.onboarding-drawer');
  await expect.poll(async () => await welcome.isVisible() || await pause.isVisible()).toBe(true);
  if (await pause.isVisible()) {
    // Restarting setup while a practice session is paused can restore both
    // surfaces after reload. Dismiss the drawer before operating the session
    // underneath it so its mask cannot intercept the click.
    if (await onboarding.isVisible()) {
      await onboarding.getByRole('button', { name: 'Close' }).click();
      await expect(onboarding).toBeHidden();
    }
    await pause.click();
    await page.getByRole('button', { name: 'Home' }).click();
  }
  await expect(welcome).toBeVisible();

  if (await onboarding.isVisible()) {
    await onboarding.getByRole('button', { name: 'Close' }).click();
    await expect(onboarding).toBeHidden();
  }
}

export async function setInterfaceMode(page: Page, mode: 'simple' | 'advanced') {
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const row = dialog.locator('.settings-row').filter({ hasText: 'Interface mode' });
  const target = mode === 'advanced' ? 'Advanced' : 'Simple';
  if (!await row.getByText(target, { exact: true }).isVisible()) {
    await row.locator('.ant-select-selector').click();
    await page.locator('.ant-select-dropdown:visible').getByText(target, { exact: true }).click();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
  } else {
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }
  await expect(dialog).toBeHidden();
}

export async function openPromptStudio(page: Page) {
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Prompt Studio' }).click();
  return dialog;
}
