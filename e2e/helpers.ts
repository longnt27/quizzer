import { expect, type Page } from '@playwright/test';

export async function dismissOnboarding(page: Page, navigate = true) {
  if (navigate) await page.goto('/');
  await page.locator('.app-shell').waitFor();
  // Saved sessions must not take over startup, even when setup is unfinished.
  await expect(page.getByRole('heading', { name: 'Welcome to Quizzer' })).toBeVisible();
  const onboarding = page.locator('.onboarding-drawer');
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
  const targetOption = row.getByRole('radio', { name: target });
  if (!await targetOption.isChecked()) {
    await row.getByText(target, { exact: true }).click();
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
