import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readUserSettings, resolveSettings, writeUserSettings } from '../server/settings.mjs';

test('resolves legacy external embedders to the plugin provider unless provider is explicit', () => {
  const legacy = resolveSettings({
    profile: 'lite',
    user: { 'embeddings.embedderPlugin': 'dev.quizzer.embedder' },
    environment: {},
  });
  assert.equal(legacy.values['embeddings.provider'], 'plugin');
  assert.equal(legacy.sources['embeddings.provider'], 'user');

  const explicit = resolveSettings({
    profile: 'lite',
    user: {
      'embeddings.provider': 'openai',
      'embeddings.embedderPlugin': 'dev.quizzer.embedder',
    },
    environment: {},
  });
  assert.equal(explicit.values['embeddings.provider'], 'openai');
  assert.equal(explicit.sources['embeddings.provider'], 'user');
});

test('persists a provider when legacy embedding settings are saved again', async () => {
  const migrationDirectory = await mkdtemp(join(tmpdir(), 'quizzer-embedding-migration-test-'));
  const path = join(migrationDirectory, 'config.jsonc');
  try {
    await writeFile(path, JSON.stringify({
      'embeddings.embedderPlugin': 'dev.quizzer.embedder',
      'extraction.ocr': false,
    }));
    const legacyPlugin = await readUserSettings(migrationDirectory);
    assert.equal('embeddings.provider' in legacyPlugin, false);
    await writeUserSettings(migrationDirectory, { ...legacyPlugin, 'extraction.ocr': true });
    assert.deepEqual(await readUserSettings(migrationDirectory), {
      'embeddings.embedderPlugin': 'dev.quizzer.embedder',
      'embeddings.provider': 'plugin',
      'extraction.ocr': true,
    });

    await writeFile(path, JSON.stringify({
      'embeddings.embedderPlugin': 'builtin',
      'extraction.ocr': false,
    }));
    const legacyBuiltin = await readUserSettings(migrationDirectory);
    assert.equal('embeddings.provider' in legacyBuiltin, false);
    await writeUserSettings(migrationDirectory, { ...legacyBuiltin, 'extraction.ocr': true });
    assert.deepEqual(await readUserSettings(migrationDirectory), {
      'embeddings.embedderPlugin': 'builtin',
      'embeddings.provider': 'ollama',
      'extraction.ocr': true,
    });
  } finally {
    await rm(migrationDirectory, { recursive: true, force: true });
  }
});
