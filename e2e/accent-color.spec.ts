import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding } from './helpers';

async function openSettings(page: Page) {
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('button', { name: /Accent color:/ })).toBeVisible();
  return dialog;
}

async function chooseAccent(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const trigger = dialog.getByRole('button', { name: /Accent color:/ });
  await trigger.click();
  const palette = page.getByRole('listbox', { name: 'Accent colors' });
  await expect(palette).toBeVisible();
  await palette.getByRole('option', { name, exact: true }).click();
  if (await palette.isVisible()) await trigger.click();
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
  await expect(dialog.getByRole('button', { name: /Reset / })).toHaveCount(0);

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
  await chooseAccent(page, 'Blue');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect.poll(() => primaryColor(page)).toBe('#69b1ff');
});

test('renders the accent picker as flush circular color controls', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await dismissOnboarding(page);
  const dialog = await openSettings(page);
  const trigger = dialog.getByRole('button', { name: 'Accent color: Blue' });

  await expect(trigger.locator('.accent-color-dot')).toHaveCount(0);
  await expect(trigger).toHaveCSS('border-radius', '50%');
  await expect(trigger).toHaveCSS('background-color', 'rgb(22, 119, 255)');
  const triggerSize = await trigger.evaluate(element => ({
    width: (element as HTMLElement).offsetWidth,
    height: (element as HTMLElement).offsetHeight,
  }));
  expect(triggerSize.width).toBe(triggerSize.height);

  await trigger.click();
  const palette = page.getByRole('listbox', { name: 'Accent colors' });
  const blue = palette.getByRole('option', { name: 'Blue', exact: true });
  await expect(blue).toHaveAttribute('aria-selected', 'true');
  await expect(blue.locator('.accent-color-dot')).toHaveCount(0);
  await expect(blue).toHaveCSS('padding-left', '0px');
  await expect(blue).toHaveCSS('padding-right', '0px');
  await expect(blue).toHaveCSS('background-color', 'rgb(22, 119, 255)');
  await expect(blue).toHaveCSS('border-top-width', '2px');
});

test('finds the accent setting by name and supports keyboard selection', async ({ page }) => {
  await dismissOnboarding(page);
  const dialog = await openSettings(page);
  await dialog.getByRole('tab', { name: 'Generation', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Search settings' }).fill('accent');
  const result = dialog.locator('.settings-search-result').filter({ hasText: 'Accent color' });
  await result.click();
  await expect(dialog.locator('#setting-accent-color')).toBeFocused();

  const trigger = dialog.getByRole('button', { name: /Accent color:/ });
  await trigger.focus();
  await trigger.press('Enter');
  const palette = page.getByRole('listbox', { name: 'Accent colors' });
  await expect(palette).toBeVisible();
  const teal = palette.getByRole('option', { name: 'Teal' });
  await teal.focus();
  await teal.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'teal');
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
    await chooseAccent(other, 'Blue');
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
  const dialog = await openSettings(page);
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect(dialog.getByRole('button', { name: 'Accent color: Blue' })).toBeVisible();
  await chooseAccent(page, 'Orange');
  await expect(page.getByText('Could not save the accent color. Check that local storage is available and try again.')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
});
