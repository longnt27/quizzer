import { createHash, createPrivateKey, KeyObject, sign } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPluginManifest, pluginSignaturePayload, validatePluginManifest, verifyPluginFiles,
} from '../plugin-sdk/manifest.mjs';
import { signRegistryCatalog } from '../plugin-sdk/registry.mjs';

const OCR_PLUGIN_DIRECTORIES = Object.freeze([
  'tesseract',
  'apple-vision',
  'google-cloud-vision',
  'aws-textract',
]);

const TESSERACT_BUNDLE_FILES = Object.freeze([
  'vendor/darwin-arm64/tesseract',
  'vendor/darwin-x64/tesseract',
  'vendor/linux-arm64/tesseract',
  'vendor/linux-x64/tesseract',
  'vendor/win32-x64/tesseract.exe',
  'tessdata/eng.traineddata',
  'licenses/Tesseract-LICENSE',
  'licenses/Leptonica-LICENSE',
  'licenses/tessdata_fast-LICENSE',
]);

const MAX_INDIVIDUAL_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const normalizePrivateKey = input => {
  if (input instanceof KeyObject) return input;
  if (typeof input !== 'string' || !input.trim()) throw new Error('Plugin registry private key is required');
  const value = input.trim();
  return value.startsWith('-----BEGIN')
    ? createPrivateKey(value)
    : createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
};

const signManifest = (manifest, keyId, privateKey) => ({
  ...manifest,
  signature: {
    algorithm: 'ed25519',
    keyId,
    value: sign(null, pluginSignaturePayload(manifest), privateKey).toString('base64'),
  },
});

const assetNameFor = (pluginId, path) => `${pluginId}-${path.replaceAll('/', '-')}`;

const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex');

const sourceManifestAssets = async (sourceDirectory, manifest) => Promise.all(manifest.files.map(async file => {
  const source = join(sourceDirectory, file.path);
  const details = await stat(source);
  return { ...file, source, size: details.size };
}));

const tesseractBundleAssets = async tesseractBundleDirectory => {
  if (typeof tesseractBundleDirectory !== 'string' || !tesseractBundleDirectory.trim()) {
    throw new Error('Tesseract bundle directory is required');
  }
  const root = resolve(tesseractBundleDirectory);
  const assets = [];
  for (const path of TESSERACT_BUNDLE_FILES) {
    const source = join(root, path);
    let details;
    try { details = await lstat(source); }
    catch { throw new Error(`Tesseract bundle file is missing or invalid: ${path}`); }
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > MAX_INDIVIDUAL_FILE_BYTES) {
      throw new Error(`Tesseract bundle file is missing or invalid: ${path}`);
    }
    assets.push({
      path,
      source,
      size: details.size,
      sha256: await sha256File(source),
    });
  }
  const total = assets.reduce((sum, asset) => sum + asset.size, 0);
  if (total > MAX_PLUGIN_DOWNLOAD_BYTES) throw new Error('Tesseract bundle exceeds the plugin download size limit');
  return assets;
};

const prepareReleasePayload = async ({ directoryName, sourceDirectory, manifest, tesseractBundleDirectory }) => {
  const sourceAssets = await sourceManifestAssets(sourceDirectory, manifest);
  if (directoryName !== 'tesseract') return { manifest, assets: sourceAssets };

  const bundleAssets = await tesseractBundleAssets(tesseractBundleDirectory);
  const releaseManifest = {
    ...manifest,
    files: [
      ...manifest.files,
      ...bundleAssets.map(({ path, sha256 }) => ({ path, sha256 })),
    ],
  };
  validatePluginManifest(releaseManifest);
  return { manifest: releaseManifest, assets: [...sourceAssets, ...bundleAssets] };
};

export const buildOcrPluginRegistry = async ({
  projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  outputDirectory = join(projectDirectory, 'dist', 'plugin-registry'),
  tesseractBundleDirectory,
  releaseTag = 'plugins-v1',
  keyId,
  privateKey: privateKeyInput,
  publishedAt = new Date().toISOString(),
  catalogVersion = '1',
} = {}) => {
  if (typeof keyId !== 'string' || !keyId.trim() || keyId.length > 100) throw new Error('Plugin registry key id is required');
  const privateKey = normalizePrivateKey(privateKeyInput);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Plugin registry private key must use Ed25519');
  const releaseRoot = `https://github.com/longnt27/quizzer/releases/download/${releaseTag}`;
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const plugins = [];
  for (const directoryName of OCR_PLUGIN_DIRECTORIES) {
    const sourceDirectory = join(projectDirectory, 'plugins', 'ocr', directoryName);
    const sourceManifest = await loadPluginManifest(sourceDirectory, { verifyFiles: true });
    await verifyPluginFiles(sourceDirectory, sourceManifest);
    const payload = await prepareReleasePayload({
      directoryName,
      sourceDirectory,
      manifest: sourceManifest,
      tesseractBundleDirectory,
    });
    const manifest = payload.manifest;
    const signedManifest = signManifest(manifest, keyId.trim(), privateKey);
    const manifestAsset = `${manifest.id}.manifest.json`;
    await writeFile(join(outputDirectory, manifestAsset), `${JSON.stringify(signedManifest, null, 2)}\n`);

    const files = [];
    let downloadSize = 0;
    for (const asset of payload.assets) {
      const assetName = assetNameFor(manifest.id, asset.path);
      await copyFile(asset.source, join(outputDirectory, assetName));
      downloadSize += asset.size;
      files.push({
        path: asset.path,
        url: `${releaseRoot}/${assetName}`,
        sha256: asset.sha256,
        size: asset.size,
      });
    }
    if (downloadSize > MAX_PLUGIN_DOWNLOAD_BYTES) throw new Error(`Plugin ${manifest.id} exceeds the plugin download size limit`);

    plugins.push({
      id: manifest.id,
      name: manifest.name,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      version: manifest.version,
      capabilities: manifest.capabilities,
      platforms: manifest.platforms,
      resources: manifest.resources,
      permissions: manifest.permissions,
      manifestUrl: `${releaseRoot}/${manifestAsset}`,
      downloadSize,
      files,
    });
  }

  const catalog = signRegistryCatalog({
    schemaVersion: 1,
    version: catalogVersion,
    publishedAt,
    signatureAlgorithm: 'ed25519',
    publicKeyId: keyId.trim(),
    plugins,
  }, privateKey);
  await writeFile(join(outputDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalog, outputDirectory };
};

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const privateKey = process.env.QUIZZER_PLUGIN_REGISTRY_PRIVATE_KEY;
  const keyId = process.env.QUIZZER_PLUGIN_REGISTRY_PUBLIC_KEY_ID;
  const releaseTag = process.env.QUIZZER_PLUGIN_REGISTRY_TAG || 'plugins-v1';
  const tesseractBundleDirectory = process.env.QUIZZER_TESSERACT_BUNDLE_DIRECTORY;
  buildOcrPluginRegistry({ privateKey, keyId, releaseTag, tesseractBundleDirectory })
    .then(({ outputDirectory, catalog }) => {
      process.stdout.write(`Prepared ${catalog.plugins.length} signed OCR plugins in ${outputDirectory}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
