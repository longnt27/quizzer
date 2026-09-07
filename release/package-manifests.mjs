import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalizeManifest, privateKeyFromBase64, verifyReleaseManifestSignature,
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

export const parseGitHubReleaseUrl = (rawUrl, expectedVersion) => {
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
  if (!version) {
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

  // Exactly one macOS x64 DMG and exactly one macOS arm64 DMG
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

  if (!macosX64Dmg.name.includes('x64') || !macosX64Dmg.name.includes(version)) {
    throw new Error(`macOS x64 DMG artifact name '${macosX64Dmg.name}' is mismatched: expected architecture 'x64' and version '${version}'`);
  }
  if (!macosArm64Dmg.name.includes('arm64') || !macosArm64Dmg.name.includes(version)) {
    throw new Error(`macOS arm64 DMG artifact name '${macosArm64Dmg.name}' is mismatched: expected architecture 'arm64' and version '${version}'`);
  }

  // Exactly one supported signed Windows installer per x64 and arm64
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

  if (!windowsX64Installer.name.includes('x64') || !windowsX64Installer.name.includes(version)) {
    throw new Error(`Windows x64 installer name '${windowsX64Installer.name}' is mismatched: expected architecture 'x64' and version '${version}'`);
  }
  if (!windowsArm64Installer.name.includes('arm64') || !windowsArm64Installer.name.includes(version)) {
    throw new Error(`Windows arm64 installer name '${windowsArm64Installer.name}' is mismatched: expected architecture 'arm64' and version '${version}'`);
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
  caskDesc = 'Local-first document-to-quiz desktop application and CLI',
  caskHomepage,
}) => {
  const version = manifest.version;
  const repository = artifacts.repository;
  const tagPrefix = artifacts.tag.startsWith('v') ? 'v' : '';
  const homepage = caskHomepage || `https://github.com/${repository}`;
  const macosCodename = resolveMacosDependency(artifacts.macosArm64Dmg.minimumOs || artifacts.macosX64Dmg.minimumOs);

  const armSha = artifacts.macosArm64Dmg.sha256;
  const intelSha = artifacts.macosX64Dmg.sha256;

  return `cask "${caskName}" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${armSha}",
         intel: "${intelSha}"

  url "https://github.com/${repository}/releases/download/${tagPrefix}#{version}/quizzer-#{version}-macos-#{arch}.dmg"
  name "${appName.replace(/\.app$/, '')}"
  desc "${caskDesc}"
  homepage "${homepage}"

  depends_on macos: ">= :${macosCodename}"

  app "${appName}"

  zap trash: [
    "~/Library/Application Support/Quizzer",
    "~/Library/Caches/dev.quizzer.app",
    "~/Library/Preferences/dev.quizzer.app.plist",
    "~/Library/Saved Application State/dev.quizzer.app.savedState",
  ]
end
`;
};

export const renderWingetManifests = ({
  manifest,
  artifacts,
  packageIdentifier = 'Quizzer.Quizzer',
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
  const version = manifest.version;
  const repository = artifacts.repository;
  const manifestVersion = '1.9.0';
  const defaultLocale = 'en-US';

  const resolvedPublisherUrl = publisherUrl || `https://github.com/${repository}`;
  const resolvedPackageUrl = packageUrl || `https://github.com/${repository}`;
  const resolvedLicenseUrl = licenseUrl || `https://github.com/${repository}/blob/main/LICENSE`;
  const resolvedCopyright = copyright || `Copyright (c) ${publisher}`;
  const resolvedDescription = description || 'Quizzer is a local-first study application that turns a reusable document library into validated mixed-format quizzes. Documents are uploaded and extracted once, tagged for later discovery, and then selected whenever you want to create either separate quizzes or one combined quiz.';

  const releaseDate = manifest.publishedAt
    ? new Date(manifest.publishedAt).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const versionYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${manifestVersion}.schema.json

PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
DefaultLocale: ${defaultLocale}
ManifestType: version
ManifestVersion: ${manifestVersion}
`;

  const isMsi = artifacts.windowsX64Installer.format === 'msi';
  const installerType = isMsi ? 'msi' : 'exe';
  const scope = isMsi ? 'machine' : 'user';

  let installerSwitchesBlock = '';
  if (!isMsi) {
    installerSwitchesBlock = `InstallerSwitches:
  Silent: --silent
  SilentWithProgress: --silent
`;
  }

  const x64Sha256 = artifacts.windowsX64Installer.sha256.toUpperCase();
  const arm64Sha256 = artifacts.windowsArm64Installer.sha256.toUpperCase();

  const installerYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${manifestVersion}.schema.json

PackageIdentifier: ${packageIdentifier}
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
ManifestVersion: ${manifestVersion}
`;

  const tagsBlock = tags.map(t => `  - ${t}`).join('\n');

  const localeYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${manifestVersion}.schema.json

PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
PackageLocale: ${defaultLocale}
Publisher: ${publisher}
PublisherUrl: ${resolvedPublisherUrl}
Author: ${author}
PackageName: ${packageName}
PackageUrl: ${resolvedPackageUrl}
License: ${license}
LicenseUrl: ${resolvedLicenseUrl}
Copyright: ${resolvedCopyright}
ShortDescription: ${shortDescription}
Description: ${resolvedDescription}
Tags:
${tagsBlock}
ManifestType: defaultLocale
ManifestVersion: ${manifestVersion}
`;

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
  packageIdentifier = 'Quizzer.Quizzer',
  packageName = 'Quizzer',
  publisher = 'Quizzer contributors',
  license = 'Apache-2.0',
  shortDescription = 'Local-first document-to-quiz desktop application and CLI.',
  description,
  caskName = 'quizzer',
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
    appName: `${packageName}.app`,
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

    const caskPath = join(outputDirectory, `${caskName}.rb`);
    const wingetVersionPath = join(outputDirectory, `${packageIdentifier}.yaml`);
    const wingetInstallerPath = join(outputDirectory, `${packageIdentifier}.installer.yaml`);
    const wingetLocalePath = join(outputDirectory, `${packageIdentifier}.locale.en-US.yaml`);

    const initial = packageIdentifier[0].toLowerCase();
    const publisherFolder = publisher.replace(/[^\w.-]/g, '');
    const packageFolder = packageName.replace(/[^\w.-]/g, '');
    const nestedDir = join(outputDirectory, 'manifests', initial, publisherFolder, packageFolder, manifest.version);
    await mkdir(nestedDir, { recursive: true });

    await Promise.all([
      writeFile(caskPath, caskContent, { mode: 0o644 }),
      writeFile(wingetVersionPath, wingetFiles.versionYaml, { mode: 0o644 }),
      writeFile(wingetInstallerPath, wingetFiles.installerYaml, { mode: 0o644 }),
      writeFile(wingetLocalePath, wingetFiles.localeYaml, { mode: 0o644 }),
      writeFile(join(nestedDir, `${packageIdentifier}.yaml`), wingetFiles.versionYaml, { mode: 0o644 }),
      writeFile(join(nestedDir, `${packageIdentifier}.installer.yaml`), wingetFiles.installerYaml, { mode: 0o644 }),
      writeFile(join(nestedDir, `${packageIdentifier}.locale.en-US.yaml`), wingetFiles.localeYaml, { mode: 0o644 }),
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
