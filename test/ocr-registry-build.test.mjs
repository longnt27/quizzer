import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyPluginSignature } from '../plugin-sdk/manifest.mjs';
import { verifyRegistryCatalogSignature } from '../plugin-sdk/registry.mjs';
import { buildOcrPluginRegistry } from '../scripts/build-ocr-plugin-registry.mjs';

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

test('builds a signed release catalog containing all first-party OCR plugins', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'quizzer-ocr-registry-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = 'ocr-test-key';
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const { catalog } = await buildOcrPluginRegistry({
    projectDirectory,
    outputDirectory,
    releaseTag: 'plugins-v1',
    keyId,
    privateKey,
    publishedAt: '2026-09-15T00:00:00.000Z',
  });

  assert.equal(catalog.plugins.length, 4);
  assert.equal(verifyRegistryCatalogSignature(catalog, { [keyId]: publicDer }), true);
  assert.deepEqual(catalog.plugins.map(plugin => plugin.id).sort(), [
    'quizzer.ocr.apple-vision',
    'quizzer.ocr.aws-textract',
    'quizzer.ocr.google-cloud-vision',
    'quizzer.ocr.tesseract',
  ]);

  for (const entry of catalog.plugins) {
    const manifestPath = join(outputDirectory, `${entry.id}.manifest.json`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(verifyPluginSignature(manifest, { [keyId]: publicDer }), true);
    assert.equal(entry.downloadSize, entry.files.reduce((total, file) => total + file.size, 0));
    for (const file of entry.files) {
      const assetName = `${entry.id}-${file.path.replaceAll('/', '-')}`;
      assert.equal((await stat(join(outputDirectory, assetName))).size, file.size);
    }
  }
});
