import { createPrivateKey, KeyObject, sign } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginManifest, pluginSignaturePayload, verifyPluginFiles } from '../plugin-sdk/manifest.mjs';
import { signRegistryCatalog } from '../plugin-sdk/registry.mjs';

const OCR_PLUGIN_DIRECTORIES = Object.freeze([
  'tesseract',
  'apple-vision',
  'google-cloud-vision',
  'aws-textract',
]);

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

export const buildOcrPluginRegistry = async ({
  projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  outputDirectory = join(projectDirectory, 'dist', 'plugin-registry'),
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
    const manifest = await loadPluginManifest(sourceDirectory, { verifyFiles: true });
    await verifyPluginFiles(sourceDirectory, manifest);
    const signedManifest = signManifest(manifest, keyId.trim(), privateKey);
    const manifestAsset = `${manifest.id}.manifest.json`;
    await writeFile(join(outputDirectory, manifestAsset), `${JSON.stringify(signedManifest, null, 2)}\n`);

    const files = [];
    let downloadSize = 0;
    for (const file of manifest.files) {
      const source = join(sourceDirectory, file.path);
      const details = await stat(source);
      const assetName = assetNameFor(manifest.id, file.path);
      await copyFile(source, join(outputDirectory, assetName));
      downloadSize += details.size;
      files.push({
        path: file.path,
        url: `${releaseRoot}/${assetName}`,
        sha256: file.sha256,
        size: details.size,
      });
    }

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
  buildOcrPluginRegistry({ privateKey, keyId, releaseTag })
    .then(({ outputDirectory, catalog }) => {
      process.stdout.write(`Prepared ${catalog.plugins.length} signed OCR plugins in ${outputDirectory}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
