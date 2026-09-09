import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding } from './helpers';

async function openSettings(page: Page) {
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('combobox', { name: 'Accent color' })).toBeVisible();
  return dialog;
}

async function chooseAccent(page: Page, name: string) {
  const row = page.getByRole('dialog', { name: 'Settings' }).locator('#setting-accent-color');
  const select = row.getByRole('combobox', { name: 'Accent color', exact: true });
  // Ant Design renders the selected label over the read-only combobox input.
  // Click its visible selector so normal pointer actionability checks still apply.
  await row.locator('.ant-select-selector').click();
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.ant-select-dropdown:visible').getByText(name, { exact: true }).click();
  await expect(select).toHaveAttribute('aria-expanded', 'false');
}

const primaryColor = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));

test('applies accents immediately in both themes and preserves the choice after reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await dismissOnboarding(page);
  const dialog = await openSettings(page);
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await chooseAccent(page, 'Purple');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'purple');
  await expect.poll(() => primaryColor(page)).toBe('#531dab');
  await expect(page.locator('.home-page button[data-onboarding-target="document"]')).toHaveCSS('background-color', 'rgb(83, 29, 171)');
  await expect(dialog.getByRole('tab', { name: 'Overall', exact: true })).toHaveCSS('background-color', 'rgb(249, 240, 255)');
  // Appearance changes neither require nor enable the server settings save.
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  await dialog.locator('#setting-theme').getByText('Dark', { exact: true }).click();
  await expect.poll(() => primaryColor(page)).toBe('#b37feb');
  await expect(dialog.getByRole('tab', { name: 'Overall', exact: true })).toHaveCSS('background-color', 'rgb(48, 32, 68)');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await dismissOnboarding(page, false);
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'purple');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => primaryColor(page)).toBe('#b37feb');

  await openSettings(page);
  await page.getByRole('button', { name: 'Reset accent color' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect.poll(() => primaryColor(page)).toBe('#69b1ff');
  await expect(page.getByRole('button', { name: 'Reset accent color' })).toBeDisabled();
});

test('finds the accent setting by name and supports keyboard selection', async ({ page }) => {
  await dismissOnboarding(page);
  const dialog = await openSettings(page);
  await dialog.getByRole('tab', { name: 'Generation', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Search settings' }).fill('accent');
  await dialog.getByRole('button', { name: /^Accent color/ }).click();
  await expect(dialog.locator('#setting-accent-color')).toBeFocused();
  const select = dialog.getByRole('combobox', { name: 'Accent color' });
  await select.focus();
  await select.press('ArrowDown');
  await select.press('ArrowDown');
  await select.press('Enter');
  await expect(page.locator('html')).not.toHaveAttribute('data-accent', 'blue');
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('synchronizes accent choices between open windows', async ({ context, page }) => {
  await dismissOnboarding(page);
  const other = await context.newPage();
  try {
    await dismissOnboarding(other);
    await openSettings(page);
    await chooseAccent(page, 'Teal');
    await expect(other.locator('html')).toHaveAttribute('data-accent', 'teal');
    await openSettings(other);
    await other.getByRole('button', { name: 'Reset accent color' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  } finally {
    await other.close();
  }
});

test('falls back from corrupt storage and reports save failures without applying an unsaved color', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('quizzer.accent-color', 'not-a-color');
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'quizzer.accent-color') throw new DOMException('Storage is full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await dismissOnboarding(page);
  await openSettings(page);
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await chooseAccent(page, 'Orange');
  await expect(page.getByText('Could not save the accent color. Check that local storage is available and try again.')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
});
