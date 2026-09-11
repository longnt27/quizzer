import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const expectCentered = async (locator: import('@playwright/test').Locator, viewportHeight: number) => {
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    if (!box) return Number.POSITIVE_INFINITY;
    const top = box.y;
    const bottom = viewportHeight - (box.y + box.height);
    return Math.abs(top - bottom);
  }, { timeout: 3_000 }).toBeLessThanOrEqual(2);

  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? 0).toBeGreaterThanOrEqual(15);
};

test('Settings and Plugins & models stay centered and scroll inside the modal', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 560 });
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');

  await page.locator('.sidebar-footer:visible').getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expectCentered(settings, 560);
  await settings.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Configure AI' }).click();
  const plugins = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(plugins).toBeVisible();
  await plugins.getByRole('tab', { name: 'Models' }).click();
  await expectCentered(plugins, 560);
  const overflow = await plugins.locator('.ant-modal-body').evaluate(element => ({
    overflowY: getComputedStyle(element).overflowY,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(overflow.overflowY).toBe('auto');
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
});
