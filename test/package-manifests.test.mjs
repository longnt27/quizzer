import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildReleaseManifest, privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';
import {
  generatePackageManifests,
  parseGitHubReleaseUrl,
  renderHomebrewCask,
  renderWingetManifests,
  validateAndExtractPackageArtifacts,
} from '../release/package-manifests.mjs';

const execute = promisify(execFile);

const createTestFixtures = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-package-manifests-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

  const files = {
    macosX64Dmg: join(directory, 'quizzer-1.0.0-beta.1-macos-x64.dmg'),
    macosArm64Dmg: join(directory, 'quizzer-1.0.0-beta.1-macos-arm64.dmg'),
    windowsX64Exe: join(directory, 'quizzer-1.0.0-beta.1-windows-x64.exe'),
    windowsArm64Exe: join(directory, 'quizzer-1.0.0-beta.1-windows-arm64.exe'),
    windowsX64Msi: join(directory, 'quizzer-1.0.0-beta.1-windows-x64.msi'),
    windowsArm64Msi: join(directory, 'quizzer-1.0.0-beta.1-windows-arm64.msi'),
    cliLinuxX64: join(directory, 'quizzer-cli-1.0.0-beta.1-linux-x64'),
  };

  await Promise.all(Object.values(files).map((path, index) => writeFile(path, `test-content-${index}`)));

  const baseArtifactDescriptors = [
    {
      path: files.macosX64Dmg, name: 'quizzer-1.0.0-beta.1-macos-x64.dmg',
      platform: 'macos', architecture: 'x64', format: 'dmg', minimumOs: 'macOS 13',
    },
    {
      path: files.macosArm64Dmg, name: 'quizzer-1.0.0-beta.1-macos-arm64.dmg',
      platform: 'macos', architecture: 'arm64', format: 'dmg', minimumOs: 'macOS 13',
    },
    {
      path: files.windowsX64Exe, name: 'quizzer-1.0.0-beta.1-windows-x64.exe',
      platform: 'windows', architecture: 'x64', format: 'exe', minimumOs: 'Windows 10 x64 / Windows 11 arm64',
    },
    {
      path: files.windowsArm64Exe, name: 'quizzer-1.0.0-beta.1-windows-arm64.exe',
      platform: 'windows', architecture: 'arm64', format: 'exe', minimumOs: 'Windows 10 x64 / Windows 11 arm64',
    },
    {
      path: files.cliLinuxX64, name: 'quizzer-cli-1.0.0-beta.1-linux-x64',
      platform: 'linux', architecture: 'x64', format: 'sea', cli: true, minimumOs: 'Current 64-bit Ubuntu or Fedora',
    },
  ];

  const buildSigned = async (descriptors = baseArtifactDescriptors, overrides = {}) => {
    const unsigned = await buildReleaseManifest({
      version: '1.0.0-beta.1',
      channel: 'beta',
      publishedAt: '2026-09-05T00:00:00.000Z',
      publicKeyId: 'quizzer-release-test',
      releaseUrl: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1',
      artifacts: descriptors,
      ...overrides,
    });
    return signReleaseManifest(unsigned, privateKeyFromBase64(privateKeyBase64));
  };

  return {
    directory,
    privateKeyBase64,
    publicKeyPem,
    files,
    baseArtifactDescriptors,
    buildSigned,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

test('generates deterministic Homebrew Cask and multi-file WinGet manifests from signed manifest', async () => {
  const env = await createTestFixtures();
  try {
    const signedManifest = await env.buildSigned();
    const manifestPath = join(env.directory, 'release-manifest.json');
    const outputDirectory = join(env.directory, 'output');
    await writeFile(manifestPath, JSON.stringify(signedManifest, null, 2));

    const result = await generatePackageManifests({
      manifestPath,
      privateKeyBase64: env.privateKeyBase64,
      outputDirectory,
      expectedPublicKeyId: 'quizzer-release-test',
    });

    assert.ok(result.files.cask);
    assert.ok(result.files.wingetVersion);
    assert.ok(result.files.wingetInstaller);
    assert.ok(result.files.wingetLocale);

    const caskContent = await readFile(result.files.cask, 'utf8');
    const wingetVersionContent = await readFile(result.files.wingetVersion, 'utf8');
    const wingetInstallerContent = await readFile(result.files.wingetInstaller, 'utf8');
    const wingetLocaleContent = await readFile(result.files.wingetLocale, 'utf8');

    // Homebrew Cask verification
    assert.match(caskContent, /^cask "quizzer" do\n/);
    assert.match(caskContent, /arch arm: "arm64", intel: "x64"/);
    assert.match(caskContent, /version "1\.0\.0-beta\.1"/);
    assert.match(caskContent, /sha256 arm:\s+"[a-f0-9]{64}",\n\s+intel:\s+"[a-f0-9]{64}"/);
    assert.match(caskContent, /url "https:\/\/github\.com\/Somethings1\/quizzer\/releases\/download\/v#\{version\}\/quizzer-#\{version\}-macos-#\{arch\}\.dmg"/);
    assert.match(caskContent, /name "Quizzer"/);
    assert.match(caskContent, /desc "Local-first document-to-quiz desktop application and CLI"/);
    assert.match(caskContent, /homepage "https:\/\/github\.com\/Somethings1\/quizzer"/);
    assert.match(caskContent, /depends_on macos: ">= :ventura"/);
    assert.match(caskContent, /app "Quizzer\.app"/);
    assert.match(caskContent, /zap trash: \[\n\s+"~\/Library\/Application Support\/Quizzer",/);

    const macosArmDmg = signedManifest.artifacts.find(a => a.platform === 'macos' && a.architecture === 'arm64' && a.format === 'dmg');
    const macosX64Dmg = signedManifest.artifacts.find(a => a.platform === 'macos' && a.architecture === 'x64' && a.format === 'dmg');
    assert.ok(caskContent.includes(macosArmDmg.sha256));
    assert.ok(caskContent.includes(macosX64Dmg.sha256));

    // WinGet Version manifest verification
    assert.match(wingetVersionContent, /ManifestType: version/);
    assert.match(wingetVersionContent, /PackageIdentifier: Quizzer\.Quizzer/);
    assert.match(wingetVersionContent, /PackageVersion: 1\.0\.0-beta\.1/);
    assert.match(wingetVersionContent, /DefaultLocale: en-US/);
    assert.match(wingetVersionContent, /ManifestVersion: 1\.9\.0/);

    // WinGet Installer manifest verification
    const windowsX64Exe = signedManifest.artifacts.find(a => a.platform === 'windows' && a.architecture === 'x64' && a.format === 'exe');
    const windowsArm64Exe = signedManifest.artifacts.find(a => a.platform === 'windows' && a.architecture === 'arm64' && a.format === 'exe');

    assert.match(wingetInstallerContent, /ManifestType: installer/);
    assert.match(wingetInstallerContent, /InstallerType: exe/);
    assert.match(wingetInstallerContent, /Scope: user/);
    assert.match(wingetInstallerContent, /Silent: --silent/);
    assert.match(wingetInstallerContent, /UpgradeBehavior: install/);
    assert.match(wingetInstallerContent, /ReleaseDate: 2026-09-05/);
    assert.match(wingetInstallerContent, /Architecture: x64/);
    assert.match(wingetInstallerContent, /Architecture: arm64/);
    assert.ok(wingetInstallerContent.includes(windowsX64Exe.sha256.toUpperCase()));
    assert.ok(wingetInstallerContent.includes(windowsArm64Exe.sha256.toUpperCase()));

    // WinGet Locale manifest verification
    assert.match(wingetLocaleContent, /ManifestType: defaultLocale/);
    assert.match(wingetLocaleContent, /PackageIdentifier: Quizzer\.Quizzer/);
    assert.match(wingetLocaleContent, /PackageLocale: en-US/);
    assert.match(wingetLocaleContent, /Publisher: Quizzer contributors/);
    assert.match(wingetLocaleContent, /PackageName: Quizzer/);
    assert.match(wingetLocaleContent, /License: Apache-2\.0/);
    assert.match(wingetLocaleContent, /ShortDescription: Local-first document-to-quiz desktop application and CLI\./);

    // Nested directory structure verification
    const nestedVersionPath = join(result.files.wingetTreeDirectory, 'Quizzer.Quizzer.yaml');
    const nestedInstallerPath = join(result.files.wingetTreeDirectory, 'Quizzer.Quizzer.installer.yaml');
    const nestedLocalePath = join(result.files.wingetTreeDirectory, 'Quizzer.Quizzer.locale.en-US.yaml');
    assert.equal(await readFile(nestedVersionPath, 'utf8'), wingetVersionContent);
    assert.equal(await readFile(nestedInstallerPath, 'utf8'), wingetInstallerContent);
    assert.equal(await readFile(nestedLocalePath, 'utf8'), wingetLocaleContent);

    // Determinism check: second generation produces byte-for-byte identical content
    const secondResult = await generatePackageManifests({
      manifestPath,
      publicKeyPem: env.publicKeyPem,
      outputDirectory: join(env.directory, 'output2'),
    });
    assert.equal(caskContent, await readFile(secondResult.files.cask, 'utf8'));
    assert.equal(wingetVersionContent, await readFile(secondResult.files.wingetVersion, 'utf8'));
    assert.equal(wingetInstallerContent, await readFile(secondResult.files.wingetInstaller, 'utf8'));
    assert.equal(wingetLocaleContent, await readFile(secondResult.files.wingetLocale, 'utf8'));
  } finally {
    await env.cleanup();
  }
});

test('supports MSI Windows installers with machine scope and no switches', async () => {
  const env = await createTestFixtures();
  try {
    const descriptors = [
      env.baseArtifactDescriptors[0], // macos x64 dmg
      env.baseArtifactDescriptors[1], // macos arm64 dmg
      {
        path: env.files.windowsX64Msi, name: 'quizzer-1.0.0-beta.1-windows-x64.msi',
        platform: 'windows', architecture: 'x64', format: 'msi', minimumOs: 'Windows 10 x64 / Windows 11 arm64',
      },
      {
        path: env.files.windowsArm64Msi, name: 'quizzer-1.0.0-beta.1-windows-arm64.msi',
        platform: 'windows', architecture: 'arm64', format: 'msi', minimumOs: 'Windows 10 x64 / Windows 11 arm64',
      },
    ];
    const signedManifest = await env.buildSigned(descriptors);
    const result = await generatePackageManifests({
      manifest: signedManifest,
      publicKeyPem: env.publicKeyPem,
    });

    assert.match(result.contents.wingetInstaller, /InstallerType: msi/);
    assert.match(result.contents.wingetInstaller, /Scope: machine/);
    assert.doesNotMatch(result.contents.wingetInstaller, /InstallerSwitches:/);
    assert.match(result.contents.wingetInstaller, /\.msi/);
  } finally {
    await env.cleanup();
  }
});

test('cryptographically verifies release manifest signature and fails closed on tampering', async () => {
  const env = await createTestFixtures();
  try {
    const signedManifest = await env.buildSigned();

    // Verification succeeds with valid key
    const validResult = await generatePackageManifests({
      manifest: signedManifest,
      publicKeyPem: env.publicKeyPem,
    });
    assert.ok(validResult.contents.cask);

    // Tampered manifest: version altered
    const tamperedVersion = { ...signedManifest, version: '1.0.1' };
    await assert.rejects(
      generatePackageManifests({ manifest: tamperedVersion, publicKeyPem: env.publicKeyPem }),
      /not signed by the supplied release key/,
    );

    // Tampered manifest: artifact hash altered
    const tamperedArtifacts = {
      ...signedManifest,
      artifacts: signedManifest.artifacts.map((a, i) => i === 0 ? { ...a, sha256: 'b'.repeat(64) } : a),
    };
    await assert.rejects(
      generatePackageManifests({ manifest: tamperedArtifacts, publicKeyPem: env.publicKeyPem }),
      /not signed by the supplied release key/,
    );

    // Wrong release key
    const { publicKey: unrelatedPublicKey } = generateKeyPairSync('ed25519');
    const unrelatedPem = unrelatedPublicKey.export({ format: 'pem', type: 'spki' }).toString();
    await assert.rejects(
      generatePackageManifests({ manifest: signedManifest, publicKeyPem: unrelatedPem }),
      /not signed by the supplied release key/,
    );

    // Missing key
    await assert.rejects(
      generatePackageManifests({ manifest: signedManifest }),
      /A release key .* is required/,
    );

    // Key ID mismatch
    await assert.rejects(
      generatePackageManifests({
        manifest: signedManifest,
        publicKeyPem: env.publicKeyPem,
        expectedPublicKeyId: 'different-key-id',
      }),
      /does not match expected 'different-key-id'/,
    );
  } finally {
    await env.cleanup();
  }
});

test('fails closed for missing or duplicate macOS DMG artifacts', async () => {
  const env = await createTestFixtures();
  try {
    // Missing macOS arm64 DMG
    const missingArm64 = env.baseArtifactDescriptors.filter(a => !(a.platform === 'macos' && a.architecture === 'arm64'));
    const signedMissingArm64 = await env.buildSigned(missingArm64);
    await assert.rejects(
      generatePackageManifests({ manifest: signedMissingArm64, publicKeyPem: env.publicKeyPem }),
      /exactly one macOS arm64 DMG artifact, found 0/,
    );

    // Missing macOS x64 DMG
    const missingX64 = env.baseArtifactDescriptors.filter(a => !(a.platform === 'macos' && a.architecture === 'x64'));
    const signedMissingX64 = await env.buildSigned(missingX64);
    await assert.rejects(
      generatePackageManifests({ manifest: signedMissingX64, publicKeyPem: env.publicKeyPem }),
      /exactly one macOS x64 DMG artifact, found 0/,
    );

    // Duplicate macOS arm64 DMG rejected at signing by target check
    const duplicateArm64 = [
      ...env.baseArtifactDescriptors,
      {
        path: env.files.macosArm64Dmg, name: 'quizzer-1.0.0-beta.1-macos-arm64-2.dmg',
        platform: 'macos', architecture: 'arm64', format: 'dmg', minimumOs: 'macOS 13',
      },
    ];
    await assert.rejects(
      env.buildSigned(duplicateArm64),
      /duplicates target macos:arm64:dmg/,
    );

    // Also assert direct extraction fails closed if multiple artifacts match
    assert.throws(
      () => validateAndExtractPackageArtifacts({
        version: '1.0.0-beta.1',
        artifacts: [
          ...signedMissingArm64.artifacts,
          {
            name: 'quizzer-1.0.0-beta.1-macos-arm64-1.dmg',
            platform: 'macos', architecture: 'arm64', format: 'dmg',
            url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1/quizzer-1.0.0-beta.1-macos-arm64-1.dmg',
            size: 100, sha256: 'a'.repeat(64), minimumOs: 'macOS 13',
          },
          {
            name: 'quizzer-1.0.0-beta.1-macos-arm64-2.dmg',
            platform: 'macos', architecture: 'arm64', format: 'dmg',
            url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1/quizzer-1.0.0-beta.1-macos-arm64-2.dmg',
            size: 100, sha256: 'b'.repeat(64), minimumOs: 'macOS 13',
          },
        ],
      }),
      /ambiguous or duplicate macOS arm64 DMG/,
    );
  } finally {
    await env.cleanup();
  }
});

test('fails closed for missing, duplicate, or mismatched Windows installer artifacts', async () => {
  const env = await createTestFixtures();
  try {
    // Missing Windows x64 installer
    const missingX64 = env.baseArtifactDescriptors.filter(a => !(a.platform === 'windows' && a.architecture === 'x64'));
    const signedMissingX64 = await env.buildSigned(missingX64);
    await assert.rejects(
      generatePackageManifests({ manifest: signedMissingX64, publicKeyPem: env.publicKeyPem }),
      /exactly one supported Windows x64 installer/,
    );

    // Missing Windows arm64 installer
    const missingArm64 = env.baseArtifactDescriptors.filter(a => !(a.platform === 'windows' && a.architecture === 'arm64'));
    const signedMissingArm64 = await env.buildSigned(missingArm64);
    await assert.rejects(
      generatePackageManifests({ manifest: signedMissingArm64, publicKeyPem: env.publicKeyPem }),
      /exactly one supported Windows arm64 installer/,
    );

    // Mismatched installer formats: x64 is exe, arm64 is msi
    const mismatched = [
      env.baseArtifactDescriptors[0],
      env.baseArtifactDescriptors[1],
      env.baseArtifactDescriptors[2], // x64 exe
      {
        path: env.files.windowsArm64Msi, name: 'quizzer-1.0.0-beta.1-windows-arm64.msi',
        platform: 'windows', architecture: 'arm64', format: 'msi', minimumOs: 'Windows 10 x64 / Windows 11 arm64',
      },
    ];
    const signedMismatched = await env.buildSigned(mismatched);
    await assert.rejects(
      generatePackageManifests({ manifest: signedMismatched, publicKeyPem: env.publicKeyPem }),
      /Windows installer formats must match across architectures: x64 is exe, arm64 is msi/,
    );
  } finally {
    await env.cleanup();
  }
});

test('fails closed for non-GitHub, unversioned, query-bearing, credential-bearing, or mismatched URLs', () => {
  assert.throws(
    () => parseGitHubReleaseUrl('http://github.com/Somethings1/quizzer/releases/download/v1.0.0/app.dmg', '1.0.0'),
    /must use HTTPS/,
  );
  assert.throws(
    () => parseGitHubReleaseUrl('https://evil.com/Somethings1/quizzer/releases/download/v1.0.0/app.dmg', '1.0.0'),
    /must be hosted on github.com/,
  );
  assert.throws(
    () => parseGitHubReleaseUrl('https://user:pass@github.com/Somethings1/quizzer/releases/download/v1.0.0/app.dmg', '1.0.0'),
    /must not contain credentials/,
  );
  assert.throws(
    () => parseGitHubReleaseUrl('https://github.com/Somethings1/quizzer/releases/download/v1.0.0/app.dmg?download=true', '1.0.0'),
    /must not contain query parameters/,
  );
  assert.throws(
    () => parseGitHubReleaseUrl('https://github.com/Somethings1/quizzer/releases/download/v1.0.0/app.dmg#section', '1.0.0'),
    /must not contain URL fragments/,
  );
  assert.throws(
    () => parseGitHubReleaseUrl('https://github.com/Somethings1/quizzer/releases/download/latest/app.dmg', '1.0.0'),
    /must be versioned/,
  );
  assert.throws(
    () => parseGitHubReleaseUrl('https://github.com/Somethings1/quizzer/releases/download/v2.0.0/app.dmg', '1.0.0'),
    /tag 'v2\.0\.0' does not match release version '1\.0\.0'/,
  );
});

test('CLI script generates package manager manifests and outputs paths', async () => {
  const env = await createTestFixtures();
  try {
    const signedManifest = await env.buildSigned();
    const manifestPath = join(env.directory, 'release-manifest.json');
    const outputDirectory = join(env.directory, 'cli-output');
    await writeFile(manifestPath, JSON.stringify(signedManifest, null, 2));

    const scriptPath = new URL('../scripts/generate-package-manifests.mjs', import.meta.url).pathname;

    const { stdout } = await execute('node', [
      scriptPath,
      '--manifest', manifestPath,
      '--output', outputDirectory,
      '--private-key', env.privateKeyBase64,
      '--public-key-id', 'quizzer-release-test',
    ], {
      env: { ...process.env, QUIZZER_RELEASE_PRIVATE_KEY: '' },
    });

    assert.match(stdout, /Generated package manager manifests ->/);
    assert.match(stdout, /quizzer\.rb/);
    assert.match(stdout, /Quizzer\.Quizzer\.yaml/);

    const caskContent = await readFile(join(outputDirectory, 'quizzer.rb'), 'utf8');
    assert.match(caskContent, /cask "quizzer"/);
  } finally {
    await env.cleanup();
  }
});

test('CLI script fails when release key is missing or manifest is invalid', async () => {
  const env = await createTestFixtures();
  try {
    const scriptPath = new URL('../scripts/generate-package-manifests.mjs', import.meta.url).pathname;

    // Missing key
    const signedManifest = await env.buildSigned();
    const manifestPath = join(env.directory, 'release-manifest.json');
    await writeFile(manifestPath, JSON.stringify(signedManifest, null, 2));

    await assert.rejects(
      execute('node', [scriptPath, '--manifest', manifestPath], {
        env: { ...process.env, QUIZZER_RELEASE_PRIVATE_KEY: '', QUIZZER_RELEASE_PUBLIC_KEY: '' },
      }),
      /A release key .* is required/,
    );
  } finally {
    await env.cleanup();
  }
});

test('package-managers.mjs re-exports all package-manifests symbols', async () => {
  const pkgManagers = await import('../release/package-managers.mjs');
  const pkgManifests = await import('../release/package-manifests.mjs');

  assert.equal(pkgManagers.generatePackageManifests, pkgManifests.generatePackageManifests);
  assert.equal(pkgManagers.renderHomebrewCask, pkgManifests.renderHomebrewCask);
  assert.equal(pkgManagers.renderWingetManifests, pkgManifests.renderWingetManifests);
  assert.equal(pkgManagers.validateAndExtractPackageArtifacts, pkgManifests.validateAndExtractPackageArtifacts);
});

test('supports custom package metadata and overrides', async () => {
  const env = await createTestFixtures();
  try {
    const signedManifest = await env.buildSigned();
    const result = await generatePackageManifests({
      manifest: signedManifest,
      publicKeyPem: env.publicKeyPem,
      packageIdentifier: 'CustomOrg.CustomApp',
      packageName: 'CustomApp',
      publisher: 'CustomOrg',
      license: 'MIT',
      shortDescription: 'Custom description.',
      caskName: 'custom-app',
    });

    assert.match(result.contents.cask, /cask "custom-app"/);
    assert.match(result.contents.cask, /name "CustomApp"/);
    assert.match(result.contents.wingetVersion, /PackageIdentifier: CustomOrg\.CustomApp/);
    assert.match(result.contents.wingetInstaller, /PackageIdentifier: CustomOrg\.CustomApp/);
    assert.match(result.contents.wingetLocale, /PackageIdentifier: CustomOrg\.CustomApp/);
    assert.match(result.contents.wingetLocale, /PackageName: CustomApp/);
    assert.match(result.contents.wingetLocale, /Publisher: CustomOrg/);
    assert.match(result.contents.wingetLocale, /License: MIT/);
    assert.match(result.contents.wingetLocale, /ShortDescription: Custom description\./);
  } finally {
    await env.cleanup();
  }
});

test('fails closed when artifacts point to conflicting repositories', () => {
  const manifest = {
    version: '1.0.0',
    artifacts: [
      {
        name: 'quizzer-1.0.0-macos-x64.dmg',
        platform: 'macos', architecture: 'x64', format: 'dmg',
        url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer-1.0.0-macos-x64.dmg',
        size: 100, sha256: 'a'.repeat(64), minimumOs: 'macOS 13',
      },
      {
        name: 'quizzer-1.0.0-macos-arm64.dmg',
        platform: 'macos', architecture: 'arm64', format: 'dmg',
        url: 'https://github.com/Attacker/quizzer/releases/download/v1.0.0/quizzer-1.0.0-macos-arm64.dmg',
        size: 100, sha256: 'b'.repeat(64), minimumOs: 'macOS 13',
      },
      {
        name: 'quizzer-1.0.0-windows-x64.exe',
        platform: 'windows', architecture: 'x64', format: 'exe',
        url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer-1.0.0-windows-x64.exe',
        size: 100, sha256: 'c'.repeat(64), minimumOs: 'Windows 10',
      },
      {
        name: 'quizzer-1.0.0-windows-arm64.exe',
        platform: 'windows', architecture: 'arm64', format: 'exe',
        url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0/quizzer-1.0.0-windows-arm64.exe',
        size: 100, sha256: 'd'.repeat(64), minimumOs: 'Windows 10',
      },
    ],
  };

  assert.throws(
    () => validateAndExtractPackageArtifacts(manifest),
    /All release artifacts must use the same versioned GitHub release repository and tag/,
  );
});

