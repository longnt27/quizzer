import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('embedding provider persistence is explicit instead of inferred from rendered titles', async () => {
  const source = await readFile(new URL('../src/components/ImmediateSettingsPersistence.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /embeddingProviderByTitle/);
  assert.doesNotMatch(source, /const embeddingProvider\s*=.*\[title\]/);
  assert.doesNotMatch(source, /serviceValues\['embeddings\.provider'\]\s*=\s*embeddingProvider/);
  assert.match(source, /serviceValues\['embeddings\.provider'\]\s*=\s*'plugin'/);
});

test('external embedder scan cannot disable an active first-party embedding provider', async () => {
  const [persistence, providerOptions] = await Promise.all([
    readFile(new URL('../src/components/ImmediateSettingsPersistence.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/EmbeddingProviderOptions.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(providerOptions, /data-embedding-provider-state=\{activeProvider\}/);
  assert.match(persistence, /embeddingProviderState/);
  assert.doesNotMatch(persistence, /sawEmbeddingToggle/);
  assert.match(persistence, /embeddingProviderState\s*===\s*['"]plugin['"]/);
  assert.match(persistence, /serviceValues\['embeddings\.enabled'\]\s*=\s*true/);
});
