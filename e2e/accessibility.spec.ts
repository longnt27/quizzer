import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

const expectNoWcagViolations = async (page: Page) => {
  await expect(page.locator('[class*="-appear-active"]:visible, [class*="-enter-active"]:visible')).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map(node => node.target),
  }))).toEqual([]);
};

const closeDialog = async (page: Page, name: string, button = 'Close') => {
  const dialog = page.getByRole('dialog', { name });
  await dialog.getByRole('button', { name: button, exact: true }).last().click();
  await expect(dialog).toBeHidden();
};

test('primary application surfaces pass automated WCAG 2.2 AA checks', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dismissOnboarding(page);
  await expectNoWcagViolations(page);

  const themeTransitionOverride = await page.addStyleTag({
    content: '*, *::before, *::after { transition-duration: 0s !important; }',
  });
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const themeSettings = page.getByRole('dialog', { name: 'Settings' });
  await themeSettings.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNoWcagViolations(page);
  await themeSettings.getByText('Light', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await closeDialog(page, 'Settings', 'Cancel');
  await themeTransitionOverride.evaluate(element => element.remove());

  await setInterfaceMode(page, 'advanced');
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.ant-modal-content').filter({ hasText: 'Settings' })).toBeVisible();
  await expectNoWcagViolations(page);
  await closeDialog(page, 'Settings');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await expectNoWcagViolations(page);
  await closeDialog(page, 'Command palette');

  await page.getByRole('button', { name: 'Add documents' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Add documents' })).toBeVisible();
  await expectNoWcagViolations(page);
  await closeDialog(page, 'Add documents', 'Cancel');

  await page.getByRole('button', { name: 'Create test' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Create tests from documents' })).toBeVisible();
  await expectNoWcagViolations(page);
  await closeDialog(page, 'Create tests from documents', 'Cancel');

  await page.getByRole('button', { name: 'View activity' }).click();
  await expect(page.getByRole('dialog', { name: 'Activity' })).toBeVisible();
  await expectNoWcagViolations(page);
  await closeDialog(page, 'Activity');

  await page.getByRole('button', { name: 'Configure AI' }).click();
  await expect(page.getByRole('dialog', { name: 'Plugins & models' })).toBeVisible();
  await expectNoWcagViolations(page);
  await closeDialog(page, 'Plugins & models');

  await page.setViewportSize({ width: 375, height: 667 });
  await page.reload();
  await dismissOnboarding(page, false);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expectNoWcagViolations(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.ant-drawer-content:not(.onboarding-drawer)')).toBeVisible();
  await expectNoWcagViolations(page);
});
