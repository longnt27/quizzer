import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('activity is a monitoring-only view', async ({ page }) => {
  await dismissOnboarding(page);
  await expect(page.locator('.generation-activity')).toHaveCount(0);
  await page.locator('.desktop-sidebar').getByRole('button', { name: 'Activity', exact: true }).click();

  const activity = page.getByRole('dialog', { name: 'Activity' });
  await expect(activity).toBeVisible();
  await expect(activity.getByRole('tab', { name: 'Quiz generation' })).toHaveAttribute('aria-selected', 'true');
  await expect(activity.getByText('No generation jobs')).toBeVisible();
  await activity.getByRole('tab', { name: 'Document indexing' }).click();
  await expect(activity.getByRole('tab', { name: 'Document indexing' })).toHaveAttribute('aria-selected', 'true');
  await expect(activity.getByText('No indexing jobs')).toBeVisible();
  await expect(activity.getByRole('slider')).toHaveCount(0);
  await expect(activity.getByText('Background work survives reloads and connection interruptions')).toHaveCount(0);
});

test('failed generation and indexing jobs can be discarded', async ({ page }) => {
  await dismissOnboarding(page);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('QuizDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['generationJobs', 'indexJobs'], 'readwrite');
    transaction.objectStore('generationJobs').put({
      id: 'failed-generation', testId: 'test-1', name: 'Failed quiz', createdAt: Date.now(), updatedAt: Date.now(),
      status: 'error', documentIds: [], options: { provider: 'codex', questionCount: 1 }, questions: [], rejected: 0, rounds: {}, error: 'Provider failed',
    });
    transaction.objectStore('indexJobs').put({
      id: 'failed-index', kind: 'index', status: 'failed', documentIds: ['document-1'], remainingDocumentIds: ['document-1'],
      completedDocumentIds: [], results: [], force: false, createdAt: Date.now(), updatedAt: Date.now(), error: 'Index failed',
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
  await dismissOnboarding(page, false);
  await page.locator('.desktop-sidebar button').filter({ hasText: 'Activity' }).click();

  const activity = page.getByRole('dialog', { name: 'Activity' });
  await expect(activity.getByText('Failed quiz')).toBeVisible();
  await activity.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Discard' }).last().click();
  await expect(activity.getByText('Failed quiz')).toHaveCount(0);

  await activity.getByRole('tab', { name: 'Document indexing' }).click();
  await expect(activity.getByRole('button', { name: 'Resume remaining' })).toBeVisible();
  await activity.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Discard' }).last().click();
  await expect(activity.getByRole('button', { name: 'Resume remaining' })).toHaveCount(0);
});
