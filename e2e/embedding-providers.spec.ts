import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('Embeddings tab exposes local and cloud first-party providers without cloud install actions', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();

  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await dialog.getByRole('tab', { name: 'Embeddings', exact: true }).click();

  for (const name of ['Ollama embeddings', 'OpenAI-compatible embeddings', 'OpenAI embeddings', 'Gemini embeddings']) {
    await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole('button', { name: 'Install OpenAI embeddings' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Install Gemini embeddings' })).toHaveCount(0);
});
