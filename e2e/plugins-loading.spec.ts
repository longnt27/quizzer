import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const idleJob = { state: 'idle', message: '' };

test('Plugins & models preloads once and only re-detects on manual refresh', async ({ page }) => {
  let integrationLoads = 0;
  let pluginLoads = 0;

  await page.route('**/api/integrations', async route => {
    integrationLoads += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        marker: { installed: false, managed: false, job: idleJob },
        ocr: { installed: false, managed: false, job: idleJob },
        codex: { installed: false, connected: false, job: idleJob },
        'claude-agent': { installed: false, connected: false, job: idleJob },
        'antigravity-agent': { installed: false, connected: false, job: idleJob },
        ollama: { installed: false, serverReady: false, models: [], job: idleJob },
        'llama-cpp': { configured: false, serverReady: false, models: [], capabilities: [], runtime: { state: 'idle' } },
        embeddings: { installed: false, runtimeInstalled: false, model: 'all-minilm', job: idleJob },
      }),
    });
  });
  await page.route('**/api/v1/plugins', async route => {
    if (!route.request().url().includes('registry')) pluginLoads += 1;
    await route.continue();
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');

  await expect.poll(() => integrationLoads).toBe(1);
  await expect.poll(() => pluginLoads).toBe(1);
  await page.waitForTimeout(2_000);
  expect(integrationLoads).toBe(1);
  expect(pluginLoads).toBe(1);

  await page.getByRole('button', { name: 'Configure AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Configure AI' }).click();
  await expect(dialog).toBeVisible();
  expect(integrationLoads).toBe(1);
  expect(pluginLoads).toBe(1);

  await dialog.getByRole('button', { name: 'Detect plugins and models again' }).click();
  await expect.poll(() => integrationLoads).toBe(2);
  await expect.poll(() => pluginLoads).toBe(2);
});
