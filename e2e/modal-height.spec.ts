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
  expect(viewportHeight - ((box?.y ?? 0) + (box?.height ?? 0))).toBeGreaterThanOrEqual(15);
};

const expectInternalScroll = async (dialog: import('@playwright/test').Locator) => {
  const overflow = await dialog.locator('.ant-modal-body').evaluate(element => ({
    overflowY: getComputedStyle(element).overflowY,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(overflow.overflowY).toBe('auto');
  expect(overflow.scrollHeight).toBeGreaterThanOrEqual(overflow.clientHeight);
};

test('all primary dialogs stay inside a short viewport and scroll internally', async ({ page }) => {
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
  await expectInternalScroll(plugins);
  await plugins.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Add documents' }).last().click();
  const documents = page.getByRole('dialog', { name: 'Add documents' });
  await expect(documents).toBeVisible();
  await expectCentered(documents, 560);
  await documents.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Create test' }).last().click();
  const createTest = page.getByRole('dialog', { name: /Create test/i });
  await expect(createTest).toBeVisible();
  await expectCentered(createTest, 560);
  await expectInternalScroll(createTest);
});
