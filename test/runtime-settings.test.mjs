import assert from 'node:assert/strict';
import test from 'node:test';
import { getProviderSettings, setProviderSettings } from '../src/utils/providerSettings.ts';
import { resolveRendererProviderSettings } from '../src/utils/runtimeProviderSettings.ts';

test('resolved service llama.cpp model replaces stale renderer settings without losing local choices', () => {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
  };
  globalThis.window = { dispatchEvent: () => true };
  try {
    const stale = getProviderSettings();
    setProviderSettings({
      ...stale,
      models: { ...stale.models, 'llama-cpp': 'local-model', ollama: 'keep-ollama' },
      enabledProviders: { ...stale.enabledProviders, 'llama-cpp': false, ollama: true },
    });
    const resolved = resolveRendererProviderSettings(getProviderSettings(), {
      'generation.defaultProvider': 'ollama',
      'extraction.marker': false,
      'extraction.ocr': true,
      'embeddings.enabled': true,
      'providers.llama-cpp.model': '  terraform-q4  ',
    });
    setProviderSettings(resolved);

    const persisted = getProviderSettings();
    assert.equal(persisted.models['llama-cpp'], 'terraform-q4');
    assert.equal(persisted.models.ollama, 'keep-ollama');
    assert.equal(persisted.enabledProviders['llama-cpp'], false);
    assert.equal(persisted.enabledProviders.ollama, true);
    assert.equal(persisted.defaultProvider, 'ollama');
    assert.deepEqual(persisted.enabledTools, { marker: false, ocr: true, embeddings: true });
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
