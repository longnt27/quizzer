import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding } from './helpers';

async function seedLibrary(page: Page) {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('QuizDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['tests', 'documents'], 'readwrite');
    const tests = transaction.objectStore('tests');
    const documents = transaction.objectStore('documents');
    const now = Date.now();

    tests.put({ id: 'selection-test-a', name: 'Alpha test', createdAt: now, questions: [], attempts: [] });
    tests.put({ id: 'selection-test-b', name: 'Beta test', createdAt: now - 1, questions: [], attempts: [] });
    tests.put({ id: 'selection-test-c', name: 'Gamma test', createdAt: now - 2, questions: [], attempts: [] });
    documents.put({ id: 'selection-doc-a', name: 'Alpha document', createdAt: now, mimeType: 'text/plain', size: 1, tags: [], content: 'A' });
    documents.put({ id: 'selection-doc-b', name: 'Beta document', createdAt: now - 1, mimeType: 'text/plain', size: 1, tags: [], content: 'B' });

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });

  await page.reload();
  await dismissOnboarding(page, false);
}

test('Ctrl-click seeds bulk selection with the test that is already open', async ({ page }) => {
  await dismissOnboarding(page);
  await seedLibrary(page);

  const sidebar = page.locator('.desktop-sidebar');
  const alpha = sidebar.locator('.ant-list-item').filter({ hasText: 'Alpha test' });
  const beta = sidebar.locator('.ant-list-item').filter({ hasText: 'Beta test' });
  const activeHeading = page.locator('.app-main h2').filter({ hasText: 'Alpha test' });

  await alpha.click();
  await expect(activeHeading).toBeVisible();
  await expect(sidebar.locator('input[type="checkbox"]')).toHaveCount(0);

  await beta.click({ modifiers: ['Control'] });

  await expect(sidebar.getByText('2 selected', { exact: true })).toBeVisible();
  await expect(alpha.locator('input[type="checkbox"]')).toBeChecked();
  await expect(beta.locator('input[type="checkbox"]')).toBeChecked();

  await sidebar.getByRole('button', { name: 'Cancel selection' }).click();
  await expect(sidebar.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(activeHeading).toBeVisible();
});

test('Shift-click from an open test selects the inclusive visible range', async ({ page }) => {
  await dismissOnboarding(page);
  await seedLibrary(page);

  const sidebar = page.locator('.desktop-sidebar');
  const alpha = sidebar.locator('.ant-list-item').filter({ hasText: 'Alpha test' });
  const beta = sidebar.locator('.ant-list-item').filter({ hasText: 'Beta test' });
  const gamma = sidebar.locator('.ant-list-item').filter({ hasText: 'Gamma test' });

  await alpha.click();
  await gamma.click({ modifiers: ['Shift'] });

  await expect(sidebar.getByText('3 selected', { exact: true })).toBeVisible();
  await expect(alpha.locator('input[type="checkbox"]')).toBeChecked();
  await expect(beta.locator('input[type="checkbox"]')).toBeChecked();
  await expect(gamma.locator('input[type="checkbox"]')).toBeChecked();
});

test('document multi-select also seeds the document that is already open', async ({ page }) => {
  await dismissOnboarding(page);
  await seedLibrary(page);

  const sidebar = page.locator('.desktop-sidebar');
  await sidebar.getByRole('tab', { name: 'Documents' }).click();
  const alpha = sidebar.locator('.ant-list-item').filter({ hasText: 'Alpha document' });
  const beta = sidebar.locator('.ant-list-item').filter({ hasText: 'Beta document' });

  await alpha.click();
  await beta.click({ modifiers: ['Control'] });

  await expect(sidebar.getByText('2 selected', { exact: true })).toBeVisible();
  await expect(alpha.locator('input[type="checkbox"]')).toBeChecked();
  await expect(beta.locator('input[type="checkbox"]')).toBeChecked();
});

test('selection checkbox leaves readable space before item content', async ({ page }) => {
  await dismissOnboarding(page);
  await seedLibrary(page);

  const sidebar = page.locator('.desktop-sidebar');
  const alpha = sidebar.locator('.ant-list-item').filter({ hasText: 'Alpha test' });
  await alpha.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select mode' }).click();

  const checkbox = alpha.locator('.sidebar-selection-checkbox');
  const meta = alpha.locator('.ant-list-item-meta');
  await expect(checkbox).toBeVisible();

  const checkboxBox = await checkbox.boundingBox();
  const metaBox = await meta.boundingBox();
  expect(checkboxBox).not.toBeNull();
  expect(metaBox).not.toBeNull();
  expect(metaBox!.x - (checkboxBox!.x + checkboxBox!.width)).toBeGreaterThanOrEqual(8);
});
