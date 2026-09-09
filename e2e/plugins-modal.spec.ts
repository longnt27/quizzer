import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Plugins & models exposes capability tabs without inline settings dropdowns', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();

  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(dialog).toBeVisible();

  const expectedTabs = ['Document extraction', 'Image OCR', 'Embeddings', 'Models'];
  await expect(dialog.getByRole('tab')).toHaveCount(expectedTabs.length);
  for (const name of expectedTabs) await expect(dialog.getByRole('tab', { name, exact: true })).toBeVisible();

  await expect(dialog.locator('.ant-alert-info')).toHaveCount(0);
  await expect(dialog.locator('.ant-select')).toHaveCount(0);
  await expect(dialog.getByRole('switch', { name: 'Use Quizzer document extraction' })).toBeChecked();

  await dialog.getByRole('tab', { name: 'Image OCR', exact: true }).click();
  await expect(dialog.getByText('RapidOCR', { exact: true })).toBeVisible();
  await expect(dialog.locator('.ant-select')).toHaveCount(0);

  await dialog.getByRole('tab', { name: 'Embeddings', exact: true }).click();
  await expect(dialog.getByText(/Ollama embeddings/)).toBeVisible();
  await expect(dialog.getByText('LanceDB vector index', { exact: true })).toBeVisible();
  await expect(dialog.locator('.ant-select')).toHaveCount(0);

  await dialog.getByRole('tab', { name: 'Models', exact: true }).click();
  await expect(dialog.getByText('Codex Agent', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Settings' }).first()).toBeVisible();
  await expect(dialog.locator('.ant-select')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Settings for Codex Agent' }).click();
  const codexSettings = page.getByRole('dialog', { name: 'Codex Agent settings' });
  await expect(codexSettings.getByRole('spinbutton', { name: 'Maximum concurrency for Codex Agent' })).toBeVisible();
  await codexSettings.getByRole('button', { name: 'Done' }).click();

  await dialog.getByRole('button', { name: 'Settings for Ollama Local' }).click();
  const ollamaSettings = page.getByRole('dialog', { name: 'Ollama Local settings' });
  await expect(ollamaSettings.getByText('Resource limits')).toHaveCount(0);
});
