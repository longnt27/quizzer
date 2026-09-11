import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

test('document tags are individual items and technical details live in a popover', async ({ page }) => {
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Add documents' }).last().click();

  const dialog = page.getByRole('dialog', { name: 'Add documents' });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'study-guide.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A short local study guide.'),
  });
  await expect(dialog.getByText('ready', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add tag to study-guide' }).click();
  await dialog.getByRole('textbox', { name: 'Add tag to study-guide' }).fill('exam');
  await dialog.getByRole('textbox', { name: 'Add tag to study-guide' }).press('Enter');
  await expect(dialog.getByText('exam', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to library' }).click();

  const documentView = page.locator('.document-view');
  await expect(documentView.getByRole('heading', { name: 'study-guide' })).toBeVisible();
  const backButton = documentView.getByRole('button', { name: 'Back to home' });
  await expect(backButton).toHaveCSS('position', 'absolute');
  await expect(backButton).toHaveCSS('left', '16px');
  await expect(backButton).toHaveCSS('top', '16px');
  await expect(documentView.getByText('exam', { exact: true })).toBeVisible();
  await expect(documentView.getByText('text/plain', { exact: true })).toHaveCount(0);
  await documentView.getByRole('button', { name: 'Document details' }).click();
  const details = page.getByRole('tooltip');
  await expect(details.getByText('text/plain', { exact: true })).toBeVisible();
  await expect(details.getByText('utf8-1', { exact: true })).toBeVisible();
  await expect(details.getByText('Not indexed', { exact: true })).toBeVisible();
  await documentView.getByRole('button', { name: 'Document details' }).click();
  await expect(details).toBeHidden();

  await documentView.getByRole('button', { name: 'Add tag to study-guide' }).click();
  await documentView.getByRole('textbox', { name: 'Add tag to study-guide' }).fill('review');
  await documentView.getByRole('textbox', { name: 'Add tag to study-guide' }).press('Enter');
  await expect(documentView.getByText('review', { exact: true })).toBeVisible();
});
