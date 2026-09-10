import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const idleJob = { state: 'idle', message: '' };

test('Plugins & models preloads once and only re-detects on manual refresh', async ({ page }) => {
  let integrationLoads = 0;
  let pluginLoads = 0;
  let registryLoads = 0;

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
  await page.route('**/api/v1/plugins/registry', async route => {
    registryLoads += 1;
    await route.continue();
  });
  await page.route('**/api/v1/plugins', async route => {
    pluginLoads += 1;
    await route.continue();
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');

  // Registry discovery is specific to Plugins & Models, so seeing it before the
  // first open proves the manager preloaded in the background. Other app hooks
  // legitimately read /api/integrations and /api/v1/plugins too, so their total
  // request counts are intentionally treated as a baseline rather than assumed
  // to be exactly one application-wide.
  await expect.poll(() => registryLoads).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const baselineIntegrationLoads = integrationLoads;
  const baselinePluginLoads = pluginLoads;
  const baselineRegistryLoads = registryLoads;

  await page.getByRole('button', { name: 'Configure AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Configure AI' }).click();
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500);
  expect(integrationLoads).toBe(baselineIntegrationLoads);
  expect(pluginLoads).toBe(baselinePluginLoads);
  expect(registryLoads).toBe(baselineRegistryLoads);

  await dialog.getByRole('button', { name: 'Detect plugins and models again' }).click();
  await expect.poll(() => integrationLoads).toBe(baselineIntegrationLoads + 1);
  await expect.poll(() => pluginLoads).toBe(baselinePluginLoads + 1);
  await expect.poll(() => registryLoads).toBe(baselineRegistryLoads + 1);
});
