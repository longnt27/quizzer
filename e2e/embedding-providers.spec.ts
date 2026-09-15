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

test('explicit embedding provider wins over a stale legacy plugin id', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.route(/\/api\/v1\/settings$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ values: {
        'hardware.profile': 'balanced',
        'embeddings.provider': 'openai',
        'embeddings.embedderPlugin': 'dev.quizzer.embedder',
        'embeddings.enabled': true,
        'embeddings.model': 'text-embedding-3-small',
        'embeddings.allowRemote': true,
      } }),
    });
  });

  await page.getByRole('button', { name: 'Configure AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await dialog.getByRole('tab', { name: 'Embeddings', exact: true }).click();

  await expect(dialog.getByRole('switch', { name: 'Use OpenAI embeddings' })).toBeChecked();
});
