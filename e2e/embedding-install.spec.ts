import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const idleJob = { state: 'idle', message: '' };

test('confirmed bge-m3 download installs the selected Ollama embedding model', async ({ page }) => {
  const installs: string[] = [];
  const settings: Record<string, unknown> = {
    'hardware.profile': 'max',
    'embeddings.provider': 'ollama',
    'embeddings.model': 'bge-m3',
    'embeddings.enabled': true,
    'embeddings.embedderPlugin': 'builtin',
    'embeddings.allowRemote': false,
  };
  await page.route(/\/api\/v1\/settings$/, async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ values: settings }) });
      return;
    }
    if (route.request().method() !== 'PATCH') return route.continue();
    const body = route.request().postDataJSON() as { values?: Record<string, unknown> };
    Object.assign(settings, body.values ?? {});
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ values: settings }) });
  });
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      marker: { installed: false, managed: false, job: idleJob },
      ocr: { installed: false, managed: false, job: idleJob },
      codex: { installed: false, connected: false, job: idleJob },
      'claude-agent': { installed: false, connected: false, job: idleJob },
      'antigravity-agent': { installed: false, connected: false, job: idleJob },
      ollama: { installed: true, serverReady: true, models: [], job: idleJob },
      'llama-cpp': { configured: false, serverReady: false, models: [], capabilities: [] },
      embeddings: { installed: false, runtimeInstalled: true, model: 'bge-m3', job: idleJob },
    }),
  }));
  await page.route('**/api/integrations/embeddings/install', async route => {
    const body = route.request().postDataJSON() as { model?: string; confirmed?: boolean };
    installs.push(`${body.model}:${body.confirmed}`);
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await dialog.getByRole('tab', { name: 'Embeddings' }).click();
  const ollama = dialog.locator('.plugin-option').filter({ hasText: 'Ollama embeddings' });
  await expect(ollama.getByText('Ollama embeddings', { exact: true })).toBeVisible();
  await expect(ollama).toContainText('bge-m3');
  await ollama.getByRole('button', { name: 'Install' }).click();

  const installConfirm = page.getByRole('dialog', { name: 'Confirm installation of Ollama embeddings' });
  await expect(installConfirm).toContainText('1.2 GB');
  await installConfirm.getByRole('button', { name: 'Install' }).click();

  await expect(page.getByRole('dialog', { name: /Download bge-m3/i })).toHaveCount(0);
  await expect.poll(() => installs).toEqual(['bge-m3:true']);
});
