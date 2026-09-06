import { expect, type Page } from '@playwright/test';

export async function dismissOnboarding(page: Page, navigate = true) {
  if (navigate) await page.goto('/');
  await page.locator('.app-shell').waitFor();
  const welcome = page.getByRole('heading', { name: 'Welcome to Quizzer' });
  const pause = page.getByRole('button', { name: 'Pause' });
  await expect.poll(async () => await welcome.isVisible() || await pause.isVisible()).toBe(true);
  if (await pause.isVisible()) {
    await pause.click();
    await page.getByRole('button', { name: 'Home' }).click();
  }
  await expect(welcome).toBeVisible();

  const onboarding = page.locator('.onboarding-drawer');
  if (await onboarding.isVisible()) {
    await onboarding.getByRole('button', { name: 'Close' }).click();
    await expect(onboarding).toBeHidden();
  }
}

export async function setInterfaceMode(page: Page, mode: 'simple' | 'advanced') {
  const switchToTarget = page.getByRole('button', {
    name: mode === 'advanced' ? 'Switch to Advanced mode' : 'Switch to Simple mode',
  });
  const targetIsActive = page.getByRole('button', {
    name: mode === 'advanced' ? 'Switch to Simple mode' : 'Switch to Advanced mode',
  });
  if (await switchToTarget.isVisible()) await switchToTarget.click();
  await expect(targetIsActive).toBeVisible();
}
