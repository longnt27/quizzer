import { test, expect } from '@playwright/test';
import { dismissOnboarding, openPromptStudio, setInterfaceMode } from './helpers';
import { readFileSync } from 'node:fs';

test('Prompt Studio clone/edit/validate plus import/export', async ({ page }) => {
  await dismissOnboarding(page);

  await setInterfaceMode(page, 'advanced');
  const studio = await openPromptStudio(page);
  await expect(studio.getByRole('tab', { name: 'Prompt Studio' })).toHaveAttribute('aria-selected', 'true');
  await expect(studio.getByRole('button', { name: 'Reset to selected profile' })).toHaveCount(0);
  await expect(studio.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await expect(studio.locator('.ant-modal-footer').getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await expect(studio.getByText('The built-in profile is read-only')).toBeHidden();
  await expect(studio.getByText('Security boundaries stay outside editable templates')).toBeHidden();

  const questionTypePlaceholder = studio.getByLabel(/questionType placeholder/);
  await questionTypePlaceholder.click();
  await expect(page.getByText('The requested output type: multiple-choice, fill-blank, reasoning, or coding.')).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Import JSON' }).locator('.anticon-download')).toBeVisible();
  await expect(studio.getByRole('button', { name: 'Export' }).locator('.anticon-upload')).toBeVisible();
  await expect(studio.locator('.prompt-preview')).toContainText('OUTPUT SCHEMA FOR MULTIPLE-CHOICE QUESTIONS');
  await expect(studio.locator('.prompt-preview')).toContainText('"correct"');

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
