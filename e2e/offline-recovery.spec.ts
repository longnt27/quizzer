import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('keeps an offline prompt edit locally and publishes it after reconnect', async ({ browser, context, page }, testInfo) => {
  const profileName = `Offline recovery ${testInfo.workerIndex}-${Date.now()}`;
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Prompt Studio' }).click();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Clone selected' }).click();
  await expect(page.getByText('Editable prompt profile created')).toBeVisible();
  await page.getByLabel('Prompt profile name').fill(profileName);
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText(`${profileName} saved as version 2`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Offline — saved locally' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Saved on server' })).toBeVisible({ timeout: 15_000 });

  const verificationContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const verificationPage = await verificationContext.newPage();
    await dismissOnboarding(verificationPage);
    await setInterfaceMode(verificationPage, 'advanced');
    await verificationPage.getByRole('button', { name: 'Prompt Studio' }).click();
    await expect(verificationPage.getByRole('button', { name: profileName, exact: false })).toBeVisible();
  } finally {
    await verificationContext.close();
  }
});
