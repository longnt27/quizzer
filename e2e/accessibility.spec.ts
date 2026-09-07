import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

const expectNoWcagViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    targets: nodes.map(node => node.target),
    summaries: nodes.map(node => node.failureSummary),
  }))).toEqual([]);
};

test('primary application surfaces pass automated WCAG 2.2 AA checks', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dismissOnboarding(page);
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  await expectNoWcagViolations(page);

  await page.getByRole('button', { name: 'Dark mode' }).click();
  const lightMode = page.getByRole('button', { name: 'Light mode' });
  await expect(lightMode).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNoWcagViolations(page);
  await page.getByRole('button', { name: 'Light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.ant-modal-content').filter({ hasText: 'Settings' })).toBeVisible();
  await expectNoWcagViolations(page);
});
