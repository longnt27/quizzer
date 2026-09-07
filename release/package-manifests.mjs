import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  privateKeyFromBase64, verifyReleaseManifestSignature,
} from './manifest.mjs';
import { validateReleaseManifest } from '../server/release-manifest.mjs';

const GITHUB_RELEASE_PATH_REGEX = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/;

const macosVersionMap = new Map([
  ['11', 'big_sur'],
  ['12', 'monterey'],
  ['13', 'ventura'],
  ['14', 'sonoma'],
  ['15', 'sequoia'],
]);

export const escapeRubyString = value => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/#\{/g, '\\#{')
    .replace(/#\$/g, '\\#$')
    .replace(/#@/g, '\\#@');
};

export const validatePackageIdentifier = id => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(id) || id.length > 128) {
    throw new Error(`Invalid packageIdentifier '${id}': must be dot-separated alphanumeric segments up to 128 characters without traversal or special characters`);
  }
  const segments = id.split('.');
  if (segments.some(seg => seg === '..' || seg === '.' || !seg)) {
    throw new Error(`Invalid packageIdentifier '${id}': traversal or empty segments are not allowed`);
  }
  return id;
};

export const validateCaskName = name => {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`Invalid caskName '${name}': must be lowercase alphanumeric with hyphens, up to 64 characters`);
  }
  return name;
};

export const validateAppName = name => {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('appName must be a non-empty string');
  }
  if (name.length > 128) {
    throw new Error('appName exceeds maximum length of 128 characters');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid appName '${name}': path traversal and separators are not allowed`);
  }
  if (!/^[A-Za-z0-9_.-]+\.app$/.test(name)) {
    throw new Error(`Invalid appName '${name}': must be a safe filename ending in .app`);
  }
  return name;
};

export const validateSingleLineText = (value, fieldName, maxLength = 256) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
  if (/[\r\n\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new Error(`${fieldName} must not contain newlines or control characters`);
  }
  return value.trim();
};

export const validateDescription = (value, maxLength = 4096) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('description must be a non-empty string');
  }
  if (value.length > maxLength) {
    throw new Error(`description exceeds maximum length of ${maxLength} characters`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) {
    throw new Error('description must not contain control characters');
  }
  return value.trim();
};

export const validateHttpsUrl = (rawUrl, fieldName) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (rawUrl.length > 512) {
    throw new Error(`${fieldName} exceeds maximum URL length of 512 characters`);
  }
  if (/[\s\r\n\x00-\x1f\x7f-\x9f]/.test(rawUrl)) {
    throw new Error(`${fieldName} must not contain whitespace or control characters`);
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for ${fieldName}: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${fieldName} must use HTTPS protocol: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} must not contain credentials: ${rawUrl}`);
  }
  return rawUrl.trim();
};

export const validateTag = tag => {
  if (typeof tag !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag) || tag.length > 32) {
    throw new Error(`Invalid tag '${tag}': must be lowercase alphanumeric with hyphens, up to 32 characters`);
  }
  return tag;
};

export const parseGitHubReleaseUrl = (rawUrl, expectedVersion) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Artifact URL must be a non-empty string');
  }
  if (/[\s\r\n\x00-\x1f\x7f-\x9f]/.test(rawUrl)) {
    throw new Error(`Artifact URL must not contain whitespace or control characters: ${rawUrl}`);
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Artifact URL must use HTTPS: ${rawUrl}`);
  }
  if (url.hostname !== 'github.com') {
    throw new Error(`Artifact URL must be hosted on github.com: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new Error(`Artifact URL must not contain credentials: ${rawUrl}`);
  }
  if (url.search) {
    throw new Error(`Artifact URL must not contain query parameters: ${rawUrl}`);
  }
  if (url.hash) {
    throw new Error(`Artifact URL must not contain URL fragments: ${rawUrl}`);
  }

  const match = GITHUB_RELEASE_PATH_REGEX.exec(url.pathname);
  if (!match) {
    throw new Error(`Artifact URL does not match canonical GitHub release download pattern: ${rawUrl}`);
  }

  const [, owner, repo, tag, filename] = match;

  if (owner !== 'Somethings1' || repo !== 'quizzer') {
    throw new Error(`Artifact URL repository must be Somethings1/quizzer, found ${owner}/${repo}: ${rawUrl}`);
  }

  if (tag === 'latest' || tag === 'download') {
    throw new Error(`Artifact URL must be versioned, found unversioned tag '${tag}': ${rawUrl}`);
  }

  if (expectedVersion) {
    const normalizedTag = tag.replace(/^v/, '');
    if (normalizedTag !== expectedVersion) {
      throw new Error(`Artifact URL tag '${tag}' does not match release version '${expectedVersion}': ${rawUrl}`);
    }
  }

  return { owner, repo, tag, filename, repository: `${owner}/${repo}` };
};

export const validateAndExtractPackageArtifacts = manifest => {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Release manifest must be an object');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('Release manifest contains no artifacts');
  }

  const version = manifest.version;
  if (!version || typeof version !== 'string') {
    throw new Error('Release manifest version is required');
  }

  let canonicalRepository = null;
  let canonicalTag = null;

  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object') {
      throw new Error('Invalid artifact entry in release manifest');
    }
    const parsedUrl = parseGitHubReleaseUrl(artifact.url, version);
    if (parsedUrl.filename !== artifact.name) {
      throw new Error(`Artifact name '${artifact.name}' does not match URL filename '${parsedUrl.filename}'`);
    }

    if (!canonicalRepository) {
      canonicalRepository = parsedUrl.repository;
      canonicalTag = parsedUrl.tag;
    } else if (parsedUrl.repository !== canonicalRepository || parsedUrl.tag !== canonicalTag) {
      throw new Error(`All release artifacts must use the same versioned GitHub release repository and tag: expected ${canonicalRepository}@${canonicalTag}, found ${parsedUrl.repository}@${parsedUrl.tag}`);
    }
  }

  if (canonicalRepository !== 'Somethings1/quizzer') {
    throw new Error(`Release repository must be Somethings1/quizzer, found ${canonicalRepository}`);
  }

  // Exact canonical names required: quizzer-{version}-macos-{arch}.dmg
  const expectedMacosX64Name = `quizzer-${version}-macos-x64.dmg`;
  const expectedMacosArm64Name = `quizzer-${version}-macos-arm64.dmg`;

  const macosDmgs = manifest.artifacts.filter(a => a.platform === 'macos' && a.format === 'dmg' && !a.cli);
  const macosX64Candidates = macosDmgs.filter(a => a.architecture === 'x64');
  const macosArm64Candidates = macosDmgs.filter(a => a.architecture === 'arm64');

  if (macosX64Candidates.length === 0) {
    throw new Error('Release manifest must contain exactly one macOS x64 DMG artifact, found 0');
  }
  if (macosX64Candidates.length > 1) {
    throw new Error(`Release manifest contains ambiguous or duplicate macOS x64 DMG artifacts (${macosX64Candidates.length})`);
  }
  if (macosArm64Candidates.length === 0) {
    throw new Error('Release manifest must contain exactly one macOS arm64 DMG artifact, found 0');
  }
  if (macosArm64Candidates.length > 1) {
    throw new Error(`Release manifest contains ambiguous or duplicate macOS arm64 DMG artifacts (${macosArm64Candidates.length})`);
  }

  const otherMacosDmgs = macosDmgs.filter(a => a.architecture !== 'x64' && a.architecture !== 'arm64');
  if (otherMacosDmgs.length > 0) {
    throw new Error(`Unsupported macOS DMG architecture: ${otherMacosDmgs[0].architecture}`);
  }

  const macosX64Dmg = macosX64Candidates[0];
  const macosArm64Dmg = macosArm64Candidates[0];

  if (macosX64Dmg.name !== expectedMacosX64Name) {
    throw new Error(`macOS x64 DMG artifact name '${macosX64Dmg.name}' does not match canonical name '${expectedMacosX64Name}'`);
  }
  if (macosArm64Dmg.name !== expectedMacosArm64Name) {
    throw new Error(`macOS arm64 DMG artifact name '${macosArm64Dmg.name}' does not match canonical name '${expectedMacosArm64Name}'`);
  }

  // Exactly one supported signed Windows desktop installer per x64 and arm64
  const windowsDesktopArtifacts = manifest.artifacts.filter(a => a.platform === 'windows' && !a.cli);
  const supportedWindowsFormats = new Set(['exe', 'msi']);

  for (const artifact of windowsDesktopArtifacts) {
    if (!supportedWindowsFormats.has(artifact.format) && artifact.format !== 'zip') {
      throw new Error(`Unsupported Windows artifact format '${artifact.format}' for ${artifact.name}`);
    }
  }

  const windowsInstallers = windowsDesktopArtifacts.filter(a => supportedWindowsFormats.has(a.format));
  const windowsX64Candidates = windowsInstallers.filter(a => a.architecture === 'x64');
  const windowsArm64Candidates = windowsInstallers.filter(a => a.architecture === 'arm64');

  if (windowsX64Candidates.length === 0) {
    throw new Error('Release manifest must contain exactly one supported Windows x64 installer (exe or msi), found 0');
  }
  if (windowsX64Candidates.length > 1) {
    throw new Error(`Release manifest contains ambiguous or duplicate Windows x64 installers (${windowsX64Candidates.length})`);
  }
  if (windowsArm64Candidates.length === 0) {
    throw new Error('Release manifest must contain exactly one supported Windows arm64 installer (exe or msi), found 0');
  }
  if (windowsArm64Candidates.length > 1) {
    throw new Error(`Release manifest contains ambiguous or duplicate Windows arm64 installers (${windowsArm64Candidates.length})`);
  }

  const windowsX64Installer = windowsX64Candidates[0];
  const windowsArm64Installer = windowsArm64Candidates[0];

  if (windowsX64Installer.format !== windowsArm64Installer.format) {
    throw new Error(`Windows installer formats must match across architectures: x64 is ${windowsX64Installer.format}, arm64 is ${windowsArm64Installer.format}`);
  }

  // Exact canonical names required: quizzer-{version}-windows-{arch}.{format}
  const expectedWindowsX64Name = `quizzer-${version}-windows-x64.${windowsX64Installer.format}`;
  const expectedWindowsArm64Name = `quizzer-${version}-windows-arm64.${windowsArm64Installer.format}`;

  if (windowsX64Installer.name !== expectedWindowsX64Name) {
    throw new Error(`Windows x64 installer name '${windowsX64Installer.name}' does not match canonical name '${expectedWindowsX64Name}'`);
  }
  if (windowsArm64Installer.name !== expectedWindowsArm64Name) {
    throw new Error(`Windows arm64 installer name '${windowsArm64Installer.name}' does not match canonical name '${expectedWindowsArm64Name}'`);
  }

  const requiredArtifacts = [macosX64Dmg, macosArm64Dmg, windowsX64Installer, windowsArm64Installer];
  for (const artifact of requiredArtifacts) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) {
      throw new Error(`Artifact ${artifact.name} has invalid signed SHA-256: ${artifact.sha256}`);
    }
  }

  return {
    repository: canonicalRepository,
    tag: canonicalTag,
    macosX64Dmg,
    macosArm64Dmg,
    windowsX64Installer,
    windowsArm64Installer,
  };
};

const resolveMacosDependency = minimumOs => {
  if (typeof minimumOs === 'string') {
    for (const [major, codename] of macosVersionMap.entries()) {
      if (minimumOs.includes(major)) {
        return codename;
      }
    }
  }
  return 'ventura';
};

export const renderHomebrewCask = ({
  manifest,
  artifacts,
  caskName = 'quizzer',
  appName = 'Quizzer.app',
  displayName,
  caskDesc = 'Local-first document-to-quiz desktop application and CLI',
  caskHomepage,
}) => {
  const validCaskName = validateCaskName(caskName);
  const validAppName = validateAppName(appName);
  const resolvedDisplayName = displayName || validAppName.replace(/\.app$/, '');
  const validDisplayName = validateSingleLineText(resolvedDisplayName, 'displayName', 128);
  const validCaskDesc = validateSingleLineText(caskDesc, 'caskDesc', 256);
  const homepage = validateHttpsUrl(caskHomepage || `https://github.com/${artifacts.repository}`, 'caskHomepage');

  const version = manifest.version;
  const repository = artifacts.repository;
  const tagPrefix = artifacts.tag.startsWith('v') ? 'v' : '';
  const macosCodename = resolveMacosDependency(artifacts.macosArm64Dmg.minimumOs || artifacts.macosX64Dmg.minimumOs);

  const armSha = artifacts.macosArm64Dmg.sha256;
  const intelSha = artifacts.macosX64Dmg.sha256;

  const escapedDisplayName = escapeRubyString(validDisplayName);
  const escapedCaskDesc = escapeRubyString(validCaskDesc);
  const escapedHomepage = escapeRubyString(homepage);
  const escapedAppName = escapeRubyString(validAppName);

  return `cask "${validCaskName}" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${armSha}",
         intel: "${intelSha}"

  url "https://github.com/${repository}/releases/download/${tagPrefix}#{version}/quizzer-#{version}-macos-#{arch}.dmg"
  name "${escapedDisplayName}"
  desc "${escapedCaskDesc}"
  homepage "${escapedHomepage}"

  depends_on macos: ">= :${macosCodename}"

  app "${escapedAppName}"

  zap trash: [
    "~/Library/Application Support/Quizzer",
    "~/Library/Caches/dev.quizzer.app",
    "~/Library/Preferences/dev.quizzer.app.plist",
    "~/Library/Saved Application State/dev.quizzer.app.savedState",
  ]
end\n`;
};

export const renderWingetManifests = ({
  manifest,
  artifacts,
  packageIdentifier = 'Somethings1.Quizzer',
  packageName = 'Quizzer',
  publisher = 'Quizzer contributors',
  author = 'Quizzer contributors',
  publisherUrl,
  packageUrl,
  license = 'Apache-2.0',
  licenseUrl,
  copyright,
  shortDescription = 'Local-first document-to-quiz desktop application and CLI.',
  description,
  tags = ['education', 'quiz', 'study', 'document', 'rag'],
}) => {
  const validPackageIdentifier = validatePackageIdentifier(packageIdentifier);
  const validPackageName = validateSingleLineText(packageName, 'packageName', 128);
  const validPublisher = validateSingleLineText(publisher, 'publisher', 128);
  const validAuthor = validateSingleLineText(author, 'author', 128);
  const validLicense = validateSingleLineText(license, 'license', 64);
  const validShortDescription = validateSingleLineText(shortDescription, 'shortDescription', 256);
  const validDescription = validateDescription(description || 'Quizzer is a local-first study application that turns a reusable document library into validated mixed-format quizzes. Documents are uploaded and extracted once, tagged for later discovery, and then selected whenever you want to create either separate quizzes or one combined quiz.', 4096);

  const resolvedPublisherUrl = validateHttpsUrl(publisherUrl || `https://github.com/${artifacts.repository}`, 'publisherUrl');
  const resolvedPackageUrl = validateHttpsUrl(packageUrl || `https://github.com/${artifacts.repository}`, 'packageUrl');
  const resolvedLicenseUrl = validateHttpsUrl(licenseUrl || `https://github.com/${artifacts.repository}/blob/main/LICENSE`, 'licenseUrl');
  const resolvedCopyright = validateSingleLineText(copyright || `Copyright (c) ${validPublisher}`, 'copyright', 256);

  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error('tags must be a non-empty array of valid tag strings');
  }
  const validatedTags = tags.map(validateTag);

  if (typeof manifest.publishedAt !== 'string' || !manifest.publishedAt.trim()) {
    throw new Error('Release manifest publishedAt is required for deterministic ReleaseDate generation');
  }
  const publishedDate = new Date(manifest.publishedAt);
  if (!Number.isFinite(publishedDate.getTime())) {
    throw new Error(`Release manifest publishedAt is not a valid date: ${manifest.publishedAt}`);
  }
  const releaseDate = publishedDate.toISOString().slice(0, 10);

  const version = manifest.version;
  const manifestVersion = '1.9.0';
  const defaultLocale = 'en-US';

  const versionYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${manifestVersion}.schema.json

PackageIdentifier: ${validPackageIdentifier}
PackageVersion: ${version}
DefaultLocale: ${defaultLocale}
ManifestType: version
ManifestVersion: ${manifestVersion}\n`;

  const isMsi = artifacts.windowsX64Installer.format === 'msi';
  const installerType = isMsi ? 'msi' : 'exe';
  const scope = isMsi ? 'machine' : 'user';

  let installerSwitchesBlock = '';
  if (!isMsi) {
    installerSwitchesBlock = `InstallerSwitches:
  Silent: --silent
  SilentWithProgress: --silent\n`;
  }

  const x64Sha256 = artifacts.windowsX64Installer.sha256.toUpperCase();
  const arm64Sha256 = artifacts.windowsArm64Installer.sha256.toUpperCase();

  const installerYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${manifestVersion}.schema.json

PackageIdentifier: ${validPackageIdentifier}
PackageVersion: ${version}
InstallerType: ${installerType}
Scope: ${scope}
InstallModes:
  - interactive
  - silent
${installerSwitchesBlock}UpgradeBehavior: install
ReleaseDate: ${releaseDate}
Installers:
  - Architecture: x64
    InstallerUrl: ${artifacts.windowsX64Installer.url}
    InstallerSha256: ${x64Sha256}
  - Architecture: arm64
    InstallerUrl: ${artifacts.windowsArm64Installer.url}
    InstallerSha256: ${arm64Sha256}
ManifestType: installer
ManifestVersion: ${manifestVersion}\n`;

  const tagsBlock = validatedTags.map(t => `  - ${t}`).join('\n');

  const localeYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${manifestVersion}.schema.json

PackageIdentifier: ${validPackageIdentifier}
PackageVersion: ${version}
PackageLocale: ${defaultLocale}
Publisher: ${JSON.stringify(validPublisher)}
PublisherUrl: ${resolvedPublisherUrl}
Author: ${JSON.stringify(validAuthor)}
PackageName: ${JSON.stringify(validPackageName)}
PackageUrl: ${resolvedPackageUrl}
License: ${JSON.stringify(validLicense)}
LicenseUrl: ${resolvedLicenseUrl}
Copyright: ${JSON.stringify(resolvedCopyright)}
ShortDescription: ${JSON.stringify(validShortDescription)}
Description: ${JSON.stringify(validDescription)}
Tags:
${tagsBlock}
ManifestType: defaultLocale
ManifestVersion: ${manifestVersion}\n`;

  return {
    versionYaml,
    installerYaml,
    localeYaml,
  };
};

export const generatePackageManifests = async ({
  manifestPath,
  manifest: manifestInput,
  privateKeyBase64,
  publicKeyPem,
  publicKey: publicKeyInput,
  expectedPublicKeyId,
  outputDirectory,
  packageIdentifier = 'Somethings1.Quizzer',
  packageName = 'Quizzer',
  publisher = 'Quizzer contributors',
  license = 'Apache-2.0',
  shortDescription = 'Local-first document-to-quiz desktop application and CLI.',
  description,
  caskName = 'quizzer',
  appName = 'Quizzer.app',
  caskDesc,
  caskHomepage,
}) => {
  let manifest = manifestInput;
  if (!manifest && manifestPath) {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  }
  if (!manifest) {
    throw new Error('manifest or manifestPath is required');
  }

  const validation = validateReleaseManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Release manifest is invalid: ${validation.errors.join('; ')}`);
  }

  let publicKey;
  if (privateKeyBase64) {
    const privateKey = privateKeyFromBase64(privateKeyBase64);
    publicKey = createPublicKey(privateKey);
  } else if (publicKeyPem) {
    publicKey = createPublicKey(publicKeyPem);
  } else if (publicKeyInput) {
    publicKey = publicKeyInput;
  } else {
    throw new Error('A release key (QUIZZER_RELEASE_PRIVATE_KEY or public key) is required to verify the release manifest');
  }

  if (!verifyReleaseManifestSignature(manifest, publicKey)) {
    throw new Error('Release manifest was not signed by the supplied release key');
  }

  if (expectedPublicKeyId && manifest.publicKeyId !== expectedPublicKeyId) {
    throw new Error(`Release manifest publicKeyId '${manifest.publicKeyId}' does not match expected '${expectedPublicKeyId}'`);
  }

  const artifacts = validateAndExtractPackageArtifacts(manifest);

  const caskContent = renderHomebrewCask({
    manifest,
    artifacts,
    caskName,
    appName,
    displayName: packageName,
    caskDesc,
    caskHomepage,
  });

  const wingetFiles = renderWingetManifests({
    manifest,
    artifacts,
    packageIdentifier,
    packageName,
    publisher,
    license,
    shortDescription,
    description,
  });

  const result = {
    contents: {
      cask: caskContent,
      wingetVersion: wingetFiles.versionYaml,
      wingetInstaller: wingetFiles.installerYaml,
      wingetLocale: wingetFiles.localeYaml,
    },
    artifacts,
  };

  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });

    const validPackageIdentifier = validatePackageIdentifier(packageIdentifier);
    const validCaskName = validateCaskName(caskName);

    const caskPath = join(outputDirectory, `${validCaskName}.rb`);
    const wingetVersionPath = join(outputDirectory, `${validPackageIdentifier}.yaml`);
    const wingetInstallerPath = join(outputDirectory, `${validPackageIdentifier}.installer.yaml`);
    const wingetLocalePath = join(outputDirectory, `${validPackageIdentifier}.locale.en-US.yaml`);

    // Derive nested winget-pkgs directory strictly from packageIdentifier segments:
    // manifests/<initial>/<Segment1>/<Segment2>/.../<Version>/
    const segments = validPackageIdentifier.split('.');
    const initial = segments[0][0].toLowerCase();
    const nestedDir = join(outputDirectory, 'manifests', initial, ...segments, manifest.version);
    await mkdir(nestedDir, { recursive: true });

    await Promise.all([
      writeFile(caskPath, caskContent, { mode: 0o644 }),
      writeFile(wingetVersionPath, wingetFiles.versionYaml, { mode: 0o644 }),
      writeFile(wingetInstallerPath, wingetFiles.installerYaml, { mode: 0o644 }),
      writeFile(wingetLocalePath, wingetFiles.localeYaml, { mode: 0o644 }),
      writeFile(join(nestedDir, `${validPackageIdentifier}.yaml`), wingetFiles.versionYaml, { mode: 0o644 }),
      writeFile(join(nestedDir, `${validPackageIdentifier}.installer.yaml`), wingetFiles.installerYaml, { mode: 0o644 }),
      writeFile(join(nestedDir, `${validPackageIdentifier}.locale.en-US.yaml`), wingetFiles.localeYaml, { mode: 0o644 }),
    ]);

    result.files = {
      cask: caskPath,
      wingetVersion: wingetVersionPath,
      wingetInstaller: wingetInstallerPath,
      wingetLocale: wingetLocalePath,
      wingetTreeDirectory: nestedDir,
    };
  }

  return result;
};
