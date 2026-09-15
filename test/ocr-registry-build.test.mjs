import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyPluginSignature } from '../plugin-sdk/manifest.mjs';
import { verifyRegistryCatalogSignature } from '../plugin-sdk/registry.mjs';
import { buildOcrPluginRegistry } from '../scripts/build-ocr-plugin-registry.mjs';

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const tesseractBundleFiles = [
  'vendor/darwin-arm64/tesseract',
  'vendor/darwin-x64/tesseract',
  'vendor/linux-arm64/tesseract',
  'vendor/linux-x64/tesseract',
  'vendor/win32-x64/tesseract.exe',
  'tessdata/eng.traineddata',
  'licenses/Tesseract-LICENSE',
  'licenses/Leptonica-LICENSE',
  'licenses/tessdata_fast-LICENSE',
];

const writeBundleFixture = async (root, { omit } = {}) => {
  for (const path of tesseractBundleFiles) {
    if (path === omit) continue;
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `fixture:${path}\n`);
  }
};

const signingFixture = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    keyId: 'ocr-test-key',
    publicDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
};

test('rejects registry builds without a complete Tesseract bundle', async t => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'quizzer-ocr-registry-missing-'));
  const incompleteBundle = await mkdtemp(join(tmpdir(), 'quizzer-tesseract-incomplete-'));
  t.after(() => Promise.all([
    rm(outputDirectory, { recursive: true, force: true }),
    rm(incompleteBundle, { recursive: true, force: true }),
  ]));
  const { privateKey, keyId } = signingFixture();

  await assert.rejects(
    () => buildOcrPluginRegistry({ projectDirectory, outputDirectory, keyId, privateKey }),
    /Tesseract bundle directory is required/,
  );

  await writeBundleFixture(incompleteBundle, { omit: 'tessdata/eng.traineddata' });
  await assert.rejects(
    () => buildOcrPluginRegistry({
      projectDirectory,
      outputDirectory,
      tesseractBundleDirectory: incompleteBundle,
      keyId,
      privateKey,
    }),
    /Tesseract bundle file is missing or invalid: tessdata\/eng\.traineddata/,
  );
});

test('builds a signed release catalog containing all first-party OCR plugins', async t => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'quizzer-ocr-registry-'));
  const tesseractBundleDirectory = await mkdtemp(join(tmpdir(), 'quizzer-tesseract-bundle-'));
  t.after(() => Promise.all([
    rm(outputDirectory, { recursive: true, force: true }),
    rm(tesseractBundleDirectory, { recursive: true, force: true }),
  ]));
  await writeBundleFixture(tesseractBundleDirectory);

  const { privateKey, keyId, publicDer } = signingFixture();
  const { catalog } = await buildOcrPluginRegistry({
    projectDirectory,
    outputDirectory,
    tesseractBundleDirectory,
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

  const tesseractEntry = catalog.plugins.find(plugin => plugin.id === 'quizzer.ocr.tesseract');
  const tesseractManifest = JSON.parse(await readFile(
    join(outputDirectory, 'quizzer.ocr.tesseract.manifest.json'),
    'utf8',
  ));
  const packagedPaths = tesseractManifest.files.map(file => file.path).sort();
  assert.deepEqual(packagedPaths, ['plugin.mjs', ...tesseractBundleFiles].sort());
  assert.deepEqual(tesseractEntry.files.map(file => file.path).sort(), packagedPaths);
});
