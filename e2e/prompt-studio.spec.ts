import { test, expect } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';
import { readFileSync } from 'node:fs';

test('Prompt Studio clone/edit/validate plus import/export', async ({ page }) => {
  await dismissOnboarding(page);

  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Prompt Studio' }).click();

  const studio = page.locator('.ant-modal-content').filter({ hasText: 'Prompt Studio' });
  await expect(studio.getByText('Prompt Studio', { exact: true })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Save new version' })).toBeHidden();
  await page.getByRole('button', { name: 'Clone selected' }).click();
  await expect(page.getByText('Editable prompt profile created')).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Quizzer balanced copy v1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save new version' })).toBeVisible();

  const profileName = page.getByLabel('Prompt profile name');
  await expect(profileName).toHaveValue('Quizzer balanced copy');
  await profileName.fill('My Custom Prompt');
  await page.getByLabel('Prompt profile description').fill('For testing');

  const generationTemplate = page.getByLabel('Generation prompt template');
  const originalTemplate = await generationTemplate.inputValue();
  await generationTemplate.fill('Invalid template without required placeholders');
  await expect(page.getByText('Generation template needs attention')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save new version' })).toBeDisabled();

  await generationTemplate.fill(`${originalTemplate}\nEmphasize concrete trade-offs.`);
  await expect(page.getByText('Generation template needs attention')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save new version' })).toBeEnabled();

  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('My Custom Prompt saved as version 2')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.quizzer-prompt\.json$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const content = readFileSync(downloadPath!, 'utf8');
  expect(content).toContain('My Custom Prompt');
  expect(content).toContain('Emphasize concrete trade-offs.');

  const deleteProfile = studio.getByRole('button', { name: 'Delete' });
  await expect(deleteProfile).toBeVisible();
  await deleteProfile.click();
  await page.getByRole('button', { name: 'Delete profile' }).click();
  await expect(page.getByText('Prompt profile deleted')).toBeVisible();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSON' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(downloadPath!);

  await expect(page.getByText('My Custom Prompt imported')).toBeVisible();
  await expect(page.getByLabel('Prompt profile name')).toHaveValue('My Custom Prompt');
});
