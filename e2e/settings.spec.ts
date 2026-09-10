import { test, expect } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('opening Settings keeps scrolling inside the modal and app panes', async ({ page }) => {
  await dismissOnboarding(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  const viewportDoesNotScroll = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement;
    if (!scrollingElement) return false;
    return scrollingElement.scrollHeight === scrollingElement.clientHeight && getComputedStyle(document.body).overflow === 'hidden';
  });
  expect(viewportDoesNotScroll).toBe(true);
});

test('Settings search and keyboard accessibility', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Settings' });
  await expect(dialog.getByText('Settings', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Overall' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: 'Interface mode' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Advanced' })).toBeChecked();
  await expect(dialog.getByRole('combobox', { name: 'Hardware profile' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Software Updates' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Software Updates' }).click();
  await expect(dialog.getByRole('region', { name: 'Software updates' }).getByText('Desktop Updates')).toBeVisible();
  await dialog.getByRole('tab', { name: 'Overall' }).click();

  await dialog.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('quizzer.theme'))).toBe('dark');

  const accentTrigger = dialog.getByRole('button', { name: /Accent color:/ });
  await expect(accentTrigger).toBeVisible();
  await accentTrigger.click();
  await expect(page.getByRole('listbox', { name: 'Accent colors' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Blue' })).toBeVisible();
  await page.keyboard.press('Escape');

  await dialog.getByRole('tab', { name: 'Retrieval' }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Context budget' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Documents' }).click();
  await expect(dialog.getByRole('switch', { name: 'OCR' })).toBeVisible();

  const search = dialog.getByLabel('Search settings');
  await search.fill('Generation concurrency');
  const result = dialog.locator('.settings-search-result').filter({ hasText: 'Generation concurrency' });
  await expect(result).toBeVisible();
  await result.click();
  const concurrencyRow = dialog.locator('.settings-row').filter({ hasText: 'Generation concurrency' });
  await expect(concurrencyRow).toBeFocused();
  const concurrency = dialog.getByRole('spinbutton', { name: 'Generation concurrency' });
  const selectedProfileConcurrency = await concurrency.inputValue();
  await concurrency.fill('7');
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /Reset / })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Built-in defaults' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await dialog.getByLabel('Search settings').fill('Generation concurrency');
  await dialog.locator('.settings-search-result').filter({ hasText: 'Generation concurrency' }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Generation concurrency' })).toHaveValue(selectedProfileConcurrency);
});

test('sidebar stays focused while command shortcuts are configurable and persistent', async ({ page }) => {
  await dismissOnboarding(page);
  const sidebar = page.locator('.sidebar-footer');
  if (await sidebar.getByRole('button', { name: 'Resume setup' }).isVisible()) {
    await sidebar.getByRole('button', { name: 'Resume setup' }).click();
    await page.getByRole('button', { name: 'Skip' }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
  }
  const tutorialAction = sidebar.locator('button').filter({ hasText: /Resume setup|Restart tutorial/ });
  await expect(tutorialAction).toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('textbox', { name: 'Search Quizzer commands' }).fill('Restart tutorial');
  await palette.getByRole('button', { name: /Restart tutorial/ }).click();
  const onboarding = page.locator('.onboarding-drawer');
  await expect(onboarding).toBeVisible();
  await onboarding.getByRole('button', { name: 'Close' }).click();
  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Shortcuts' }).click();
  const paletteRow = settings.locator('.settings-row').filter({ hasText: 'Open command palette' });
  await paletteRow.getByRole('button', { name: 'Record shortcut for Open command palette' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Y' : 'Control+Shift+Y');
  await expect(paletteRow.getByText(process.platform === 'darwin' ? '⌘ ⇧ Y' : 'Ctrl + Shift + Y', { exact: true })).toBeVisible();
  const settingsRow = settings.locator('.settings-row').filter({ hasText: 'Open Settings' });
  await settingsRow.getByRole('button', { name: 'Record shortcut for Open Settings' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Y' : 'Control+Shift+Y');
  await expect(page.getByText('That shortcut is already used by Open command palette.')).toBeVisible();
  await page.keyboard.press('Escape');
  await settings.getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Y' : 'Control+Shift+Y');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Command palette' }).getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await dismissOnboarding(page, false);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Y' : 'Control+Shift+Y');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});

test('Settings sidebar supports tablist keyboard navigation and narrow layout without horizontal overflow', async ({ page }) => {
  await dismissOnboarding(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Settings' });
  await expect(dialog.getByText('Settings', { exact: true })).toBeVisible();
  const overall = dialog.getByRole('tab', { name: 'Overall' });
  await overall.focus();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('tab', { name: 'Software Updates' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(dialog.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(overall).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 500, height: 800 });
  const sidebar = dialog.locator('.settings-sidebar');
  await expect(sidebar).toHaveCSS('flex-direction', 'column');
  await expect(dialog.locator('.settings-tab-list')).toHaveCSS('flex-direction', 'row');
  await expect(dialog.locator('.settings-content-pane')).toHaveCSS('overflow-y', 'auto');
  const hasHorizontalOverflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);
});
