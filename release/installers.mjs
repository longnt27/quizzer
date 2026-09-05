import { createPublicKey } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalizeManifest, privateKeyFromBase64, verifyReleaseManifestSignature,
} from './manifest.mjs';
import { validateReleaseManifest } from '../server/release-manifest.mjs';

const publicKeyPlaceholder = '__QUIZZER_RELEASE_PUBLIC_KEY_PEM__';
const releaseBaseUrlPlaceholder = '__QUIZZER_RELEASE_BASE_URL__';

const renderTemplate = (template, publicKeyPem, releaseBaseUrl) => {
  if (template.split(publicKeyPlaceholder).length !== 2) throw new Error('Installer template must contain the release public key placeholder exactly once');
  if (template.split(releaseBaseUrlPlaceholder).length !== 2) throw new Error('Installer template must contain the release base URL placeholder exactly once');
  return template.replace(publicKeyPlaceholder, publicKeyPem.trim()).replace(releaseBaseUrlPlaceholder, releaseBaseUrl);
};

const releaseBaseUrlFor = manifest => {
  const bases = new Set(manifest.artifacts.map(artifact => {
    const url = new URL(artifact.url);
    return `${url.origin}${url.pathname.slice(0, url.pathname.lastIndexOf('/'))}`;
  }));
  if (bases.size !== 1) throw new Error('All release artifacts must use the same versioned download directory');
  return [...bases][0];
};

export const prepareReleaseInstallers = async ({
  manifestPath,
  privateKeyBase64,
  outputDirectory,
  shellTemplatePath,
  powershellTemplatePath,
}) => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const validation = validateReleaseManifest(manifest);
  if (!validation.valid) throw new Error(`Release manifest is invalid: ${validation.errors.join('; ')}`);
  const privateKey = privateKeyFromBase64(privateKeyBase64);
  const publicKey = createPublicKey(privateKey);
  if (!verifyReleaseManifestSignature(manifest, publicKey)) throw new Error('Release manifest was not signed by the supplied release key');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const releaseBaseUrl = releaseBaseUrlFor(manifest);
  const [shellTemplate, powershellTemplate] = await Promise.all([
    readFile(shellTemplatePath, 'utf8'), readFile(powershellTemplatePath, 'utf8'),
  ]);
  const canonicalMetadata = canonicalizeManifest(manifest);
  const signature = Buffer.from(manifest.signature, 'base64url');
  await mkdir(outputDirectory, { recursive: true });
  const paths = {
    metadata: join(outputDirectory, 'release-manifest.canonical.json'),
    signature: join(outputDirectory, 'release-manifest.sig'),
    shell: join(outputDirectory, 'install.sh'),
    powershell: join(outputDirectory, 'install.ps1'),
  };
  await Promise.all([
    writeFile(paths.metadata, canonicalMetadata, { mode: 0o644 }),
    writeFile(paths.signature, signature, { mode: 0o644 }),
    writeFile(paths.shell, renderTemplate(shellTemplate, publicKeyPem, releaseBaseUrl), { mode: 0o755 }),
    writeFile(paths.powershell, renderTemplate(powershellTemplate, publicKeyPem, releaseBaseUrl), { mode: 0o644 }),
  ]);
  await chmod(paths.shell, 0o755);
  return { ...paths, publicKeyPem };
};
