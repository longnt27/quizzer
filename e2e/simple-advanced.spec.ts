import { test, expect } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('immediate reversible Simple/Advanced disclosure with stored data retained', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'simple');

  const advancedToggle = page.getByRole('button', { name: 'Switch to Advanced mode' });
  await expect(advancedToggle).toBeVisible();
  await advancedToggle.click();

  const simpleToggle = page.getByRole('button', { name: 'Switch to Simple mode' });
  const studioButton = page.getByRole('button', { name: 'Prompt Studio' });
  await expect(simpleToggle).toBeVisible();
  await expect(studioButton).toBeVisible();

  await studioButton.click();
  await page.getByRole('button', { name: 'Clone selected' }).click();
  await page.getByLabel('Prompt profile name').fill('Mode-safe profile');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('Mode-safe profile saved as version 2')).toBeVisible();
  await page.locator('.ant-modal-content').filter({ hasText: 'Prompt Studio' })
    .getByRole('button', { name: 'Close', exact: true }).last().click();

  await simpleToggle.click();
  await expect(advancedToggle).toBeVisible();
  await expect(studioButton).toBeHidden();

  await page.reload();
  await dismissOnboarding(page, false);
  await expect(advancedToggle).toBeVisible();
  await expect(studioButton).toBeHidden();

  await advancedToggle.click();
  await studioButton.click();
  await expect(page.getByRole('button', { name: 'Mode-safe profile' })).toBeVisible();
});
