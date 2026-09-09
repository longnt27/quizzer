import { test, expect } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('opening Settings keeps scrolling inside the modal and app panes', async ({ page }) => {
  await dismissOnboarding(page);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();

  const viewportDoesNotScroll = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement;
    if (!scrollingElement) return false;
    return scrollingElement.scrollHeight === scrollingElement.clientHeight
      && getComputedStyle(document.body).overflow === 'hidden';
  });
  expect(viewportDoesNotScroll).toBe(true);
});

test('Settings search/reset and keyboard accessibility', async ({ page }) => {
  await dismissOnboarding(page);

  await setInterfaceMode(page, 'advanced');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Settings' });
  await expect(dialog.getByText('Settings', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Overall' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  await expect(dialog.locator('.settings-row').filter({ hasText: 'Interface mode' }).getByText('Advanced', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Hardware profile' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Software Updates' })).toBeVisible();
  await expect(dialog.locator('.updater-status-card')).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Software Updates' }).click();
  await expect(dialog.getByRole('region', { name: 'Software updates' }).getByText('Desktop Updates')).toBeVisible();
  await dialog.getByRole('tab', { name: 'Overall' }).click();

  await dialog.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('quizzer.theme'))).toBe('dark');

  await dialog.getByRole('tab', { name: 'Retrieval' }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Context budget' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Reranker component' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Documents' }).click();
  await expect(dialog.getByRole('switch', { name: 'OCR' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Document extractor component' })).toBeVisible();

  const search = dialog.getByLabel('Search settings');
  await search.fill('Generation concurrency');
  await expect(dialog.getByRole('tab', { name: 'Generation' })).toHaveAttribute('aria-selected', 'true');
  const concurrency = dialog.getByRole('spinbutton', { name: 'Generation concurrency' });
  await expect(concurrency).toBeVisible();
  const selectedProfileConcurrency = await concurrency.inputValue();
  await expect(dialog.getByText('Hardware profile', { exact: true })).toBeHidden();

  await concurrency.fill('7');
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Reset to selected profile' }).click();
  await expect(concurrency).toHaveValue(selectedProfileConcurrency);

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await dialog.getByLabel('Search settings').fill('Generation concurrency');
  await expect(dialog.getByRole('spinbutton', { name: 'Generation concurrency' })).toHaveValue(selectedProfileConcurrency);
});

test('sidebar stays focused while command shortcuts are configurable and persistent', async ({ page }) => {
  await dismissOnboarding(page);

  // Skip tutorial to reach finished state
  const sidebar = page.locator('.sidebar-footer');
  if (await sidebar.getByRole('button', { name: 'Resume setup' }).isVisible()) {
    await sidebar.getByRole('button', { name: 'Resume setup' }).click();
    await page.getByRole('button', { name: 'Skip' }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
  }

  const tutorialAction = sidebar.locator('button').filter({ hasText: /Resume setup|Restart tutorial/ });
  await expect(tutorialAction).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Command palette' })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: /Switch to (Simple|Advanced) mode/ })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: /(Light|Dark) mode/ })).toHaveCount(0);

  // Test that command palette can still restart the tutorial
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('textbox', { name: 'Search Quizzer commands' }).fill('Restart tutorial');
  await palette.getByRole('button', { name: /Restart tutorial/ }).click();
  
  const onboarding = page.locator('.onboarding-drawer');
  await expect(onboarding).toBeVisible();
  await onboarding.getByRole('button', { name: 'Close' }).click();
  await expect(onboarding).toBeHidden();

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

test('Settings sidebar supports tablist keyboard navigation and narrow layout', async ({ page }) => {
  await dismissOnboarding(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Settings' });
  await expect(dialog.getByText('Settings', { exact: true })).toBeVisible();

  const overall = dialog.getByRole('tab', { name: 'Overall' });
  await overall.focus();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('tab', { name: 'Software Updates' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tab', { name: 'Software Updates' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute('aria-selected', 'true');
  await expect(overall).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('End');
  await expect(dialog.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(overall).toHaveAttribute('aria-selected', 'true');
  await expect(overall).toBeFocused();

  await page.setViewportSize({ width: 500, height: 800 });
  const sidebar = dialog.locator('.settings-sidebar');
  await expect(sidebar).toHaveCSS('flex-direction', 'row');
  await expect(dialog.locator('.settings-content-pane')).toHaveCSS('overflow-y', 'auto');
});
