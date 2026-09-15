import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readUserSettings, writeUserSettings } from '../server/settings.mjs';

test('persists Ollama when legacy settings relied on the built-in embedding default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-embedding-default-migration-test-'));
  const path = join(directory, 'config.jsonc');
  try {
    await writeFile(path, JSON.stringify({ 'extraction.ocr': false }));
    const legacy = await readUserSettings(directory);
    assert.equal('embeddings.provider' in legacy, false);
    assert.equal('embeddings.embedderPlugin' in legacy, false);

    await writeUserSettings(directory, { ...legacy, 'extraction.ocr': true });

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      'extraction.ocr': true,
      'embeddings.provider': 'ollama',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
