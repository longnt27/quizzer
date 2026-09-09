import { expect, test } from '@playwright/test';
import { dismissOnboarding, openPromptStudio, setInterfaceMode } from './helpers';

const pendingBrowserChanges = (page: import('@playwright/test').Page) => page.evaluate(async () => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('QuizDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = database.transaction('syncChanges', 'readonly').objectStore('syncChanges').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
});

test('keeps an offline prompt edit locally and publishes it after reconnect', async ({ browser, context, page }, testInfo) => {
  const profileName = `Offline recovery ${testInfo.workerIndex}-${Date.now()}`;
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await openPromptStudio(page);

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Clone selected' }).click();
  await expect(page.getByText('Editable prompt profile created')).toBeVisible();
  await page.getByLabel('Prompt profile name').fill(profileName);
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText(`${profileName} saved as version 2`)).toBeVisible();
  await expect.poll(() => pendingBrowserChanges(page)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: /Syncing library|Saved on server|Offline — saved locally/ })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Library sync' })).toHaveCount(0);

  await context.setOffline(false);
  await expect.poll(() => pendingBrowserChanges(page), { timeout: 15_000 }).toBe(0);

  const verificationContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const verificationPage = await verificationContext.newPage();
    await dismissOnboarding(verificationPage);
    await setInterfaceMode(verificationPage, 'advanced');
    await openPromptStudio(verificationPage);
    await expect(verificationPage.getByRole('button', { name: profileName, exact: false })).toBeVisible();
  } finally {
    await verificationContext.close();
  }
});
