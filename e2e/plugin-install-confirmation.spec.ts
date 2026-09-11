import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const idleJob = { state: 'idle', message: '' };

const integrationStatus = (embeddings: { installed: boolean; model: string } = { installed: true, model: 'all-minilm' }) => ({
  marker: { installed: false, managed: false, job: idleJob }, ocr: { installed: true, managed: true, job: idleJob },
  codex: { installed: true, connected: true, job: idleJob }, 'claude-agent': { installed: true, connected: true, job: idleJob },
  'antigravity-agent': { installed: true, connected: true, job: idleJob },
  ollama: { installed: true, serverReady: true, models: [], job: idleJob },
  'llama-cpp': { configured: false, serverReady: false, models: [], capabilities: [] },
  embeddings: { ...embeddings, runtimeInstalled: true, job: idleJob },
});

test('plugin installation asks for disk-space confirmation before starting', async ({ page }) => {
  let markerInstalls = 0;
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(integrationStatus()),
  }));
  await page.route('**/api/integrations/marker/install', route => { markerInstalls += 1; return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();
  const plugins = page.getByRole('dialog', { name: 'Plugins & models' });
  const marker = plugins.locator('.plugin-option').filter({ hasText: 'Marker visual extraction' });
  await marker.getByRole('button', { name: 'Install' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm installation of Marker visual extraction' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('additional disk space on this device');
  expect(markerInstalls).toBe(0);
  await confirmation.getByRole('button', { name: 'Install' }).click();
  await expect.poll(() => markerInstalls).toBe(1);
});

test('bge-m3 uses the popover as its only install confirmation', async ({ page }) => {
  let installs = 0;
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(integrationStatus({ installed: false, model: 'bge-m3' })),
  }));
  await page.route('**/api/integrations/embeddings/install', route => {
    installs += 1;
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();

  const plugins = page.getByRole('dialog', { name: 'Plugins & models' });
  await plugins.getByRole('tab', { name: 'Embeddings' }).click();
  const embeddings = plugins.locator('.plugin-option').filter({ hasText: 'Ollama embeddings · bge-m3' });
  await embeddings.getByRole('button', { name: 'Install' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Confirm installation of Ollama embeddings · bge-m3' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('1.2 GB');
  await confirmation.getByRole('button', { name: 'Install' }).click();

  await expect.poll(() => installs).toBe(1);
  await expect(page.getByRole('dialog', { name: /Download bge-m3 for dense retrieval/i })).toHaveCount(0);
});
