import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const idleJob = { state: 'idle', message: '' };

test('confirmed bge-m3 download selects the model before starting installation', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      marker: { installed: false, managed: false, job: idleJob }, ocr: { installed: false, managed: false, job: idleJob },
      codex: { installed: false, connected: false, job: idleJob }, 'claude-agent': { installed: false, connected: false, job: idleJob },
      'antigravity-agent': { installed: false, connected: false, job: idleJob },
      ollama: { installed: true, serverReady: true, models: [], job: idleJob },
      'llama-cpp': { configured: false, serverReady: false, models: [], capabilities: [] },
      embeddings: { installed: false, runtimeInstalled: true, model: 'bge-m3', job: idleJob },
    }),
  }));
  await page.route('**/api/v1/settings', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const body = route.request().postDataJSON() as { values?: Record<string, unknown> };
    if (body.values?.['embeddings.model'] !== undefined) requests.push(`settings:${body.values['embeddings.model']}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ values: body.values ?? {} }) });
  });
  await page.route('**/api/integrations/embeddings/install', async route => {
    const body = route.request().postDataJSON() as { model?: string; confirmed?: boolean };
    requests.push(`install:${body.model}:${body.confirmed}`);
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
  });
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await dialog.getByRole('tab', { name: 'Embeddings' }).click();
  await expect(dialog.getByText('Ollama embeddings · bge-m3', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Install' }).first().click();

  const confirmation = page.locator('.ant-modal-confirm').filter({ hasText: 'Download bge-m3 for dense retrieval?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Download bge-m3' }).click();
  await expect.poll(() => requests).toEqual(['settings:bge-m3', 'install:bge-m3:true']);
});
