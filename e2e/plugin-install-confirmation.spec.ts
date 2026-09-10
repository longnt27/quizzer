import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const idleJob = { state: 'idle', message: '' };

test('plugin installation asks for disk-space confirmation before starting', async ({ page }) => {
  let markerInstalls = 0;
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      marker: { installed: false, managed: false, job: idleJob }, ocr: { installed: true, managed: true, job: idleJob },
      codex: { installed: true, connected: true, job: idleJob }, 'claude-agent': { installed: true, connected: true, job: idleJob },
      'antigravity-agent': { installed: true, connected: true, job: idleJob },
      ollama: { installed: true, serverReady: true, models: [], job: idleJob },
      'llama-cpp': { configured: false, serverReady: false, models: [], capabilities: [] },
      embeddings: { installed: true, runtimeInstalled: true, model: 'all-minilm', job: idleJob },
    }),
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
