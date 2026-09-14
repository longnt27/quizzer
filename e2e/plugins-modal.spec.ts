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

test('Plugins & models keeps detection in the title and does not expose local plugin installation', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();

  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(dialog.getByRole('button', { name: 'Detect plugins and models again' })).toBeVisible();
  await expect(dialog.getByText('Choose a capability, then enable a detected option or install one.')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Install local plugin' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Detect again', exact: true })).toHaveCount(0);
});

test('uninstalled plugin and provider options do not show enable switches', async ({ page }) => {
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      marker: { installed: false, managed: false, job: { state: 'idle', message: '' } },
      ocr: { installed: false, managed: false, job: { state: 'idle', message: '' } },
      codex: { installed: false, connected: false, job: { state: 'idle', message: '' } },
      'claude-agent': { installed: false, connected: false, job: { state: 'idle', message: '' } },
      'antigravity-agent': { installed: false, connected: false, job: { state: 'idle', message: '' } },
      ollama: { installed: false, serverReady: false, models: [], job: { state: 'idle', message: '' } },
      'llama-cpp': { configured: false, serverReady: false, models: [], capabilities: [] },
      embeddings: { installed: false, runtimeInstalled: false, model: 'nomic-embed-text', job: { state: 'idle', message: '' } },
    }),
  }));
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Configure AI' }).click();

  const dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(dialog.getByRole('switch', { name: 'Use Marker for automatic PDF extraction' })).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Image OCR' }).click();
  await expect(dialog.getByRole('switch', { name: 'Enable RapidOCR' })).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Embeddings' }).click();
  await expect(dialog.getByRole('switch', { name: 'Enable Ollama embeddings' })).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Models' }).click();
  await expect(dialog.getByRole('switch', { name: 'Enable Codex Agent' })).toHaveCount(0);
  await expect(dialog.getByRole('switch', { name: 'Enable Ollama Local' })).toHaveCount(0);
});

test('making Codex the default provider persists immediately and survives reload', async ({ page }) => {
  const idleJob = { state: 'idle', message: '' };
  let configuredDefault = 'antigravity-agent';
  const defaultProviderPatches: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem('quizzer.providerSettings', JSON.stringify({ defaultProvider: 'antigravity-agent' }));
  });
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      marker: { installed: false, managed: false, job: idleJob },
      ocr: { installed: false, managed: false, job: idleJob },
      codex: { installed: true, connected: true, job: idleJob },
      'claude-agent': { installed: false, connected: false, job: idleJob },
      'antigravity-agent': { installed: true, connected: true, job: idleJob },
      ollama: { installed: false, serverReady: false, models: [], job: idleJob },
      'llama-cpp': { configured: false, serverReady: false, models: [], capabilities: [], runtime: { state: 'idle' } },
      embeddings: { installed: false, runtimeInstalled: false, model: 'all-minilm', job: idleJob },
    }),
  }));
  await page.route('**/api/v1/settings**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== '/api/v1/settings') return route.continue();
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { values?: Record<string, unknown> };
      const requestedDefault = body.values?.['generation.defaultProvider'];
      if (typeof requestedDefault === 'string') {
        configuredDefault = requestedDefault;
        defaultProviderPatches.push(requestedDefault);
      }
    }
    const response = await route.fetch();
    const payload = await response.json() as { values?: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { ...payload, values: { ...(payload.values ?? {}), 'generation.defaultProvider': configuredDefault } },
    });
  });

  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Configure AI' }).click();
  let dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await dialog.getByRole('tab', { name: 'Models', exact: true }).click();

  const antigravity = dialog.locator('.plugin-option').filter({ hasText: 'Antigravity Agent' });
  const codex = dialog.locator('.plugin-option').filter({ hasText: 'Codex Agent' });
  await expect(antigravity.getByRole('button', { name: 'Default', exact: true })).toBeVisible();
  await codex.getByRole('button', { name: 'Make default', exact: true }).click();
  await expect(codex.getByRole('button', { name: 'Default', exact: true })).toBeVisible();
  await expect.poll(() => defaultProviderPatches).toContain('codex');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('quizzer.providerSettings') ?? '{}').defaultProvider)).toBe('codex');

  await page.reload();
  await dismissOnboarding(page, false);
  await page.getByRole('button', { name: 'Configure AI' }).click();
  dialog = page.getByRole('dialog', { name: 'Plugins & models' });
  await dialog.getByRole('tab', { name: 'Models', exact: true }).click();
  await expect(dialog.locator('.plugin-option').filter({ hasText: 'Codex Agent' })
    .getByRole('button', { name: 'Default', exact: true })).toBeVisible();
});
