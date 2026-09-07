import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectReleaseArtifacts, mergeReleaseArtifacts } from '../release/artifacts.mjs';

test('normalizes and merges cross-platform release artifacts without ambiguous targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-artifacts-'));
  try {
    const builds = join(directory, 'builds');
    const downloads = join(directory, 'downloads');
    await mkdir(join(builds, 'mac', 'zip'), { recursive: true });
    await mkdir(join(builds, 'mac', 'pkg'), { recursive: true });
    await mkdir(join(builds, 'mac', 'dmg'), { recursive: true });
    await mkdir(join(builds, 'linux', 'deb'), { recursive: true });
    await writeFile(join(builds, 'mac', 'zip', 'Quizzer-darwin-arm64.zip'), 'mac artifact');
    await writeFile(join(builds, 'mac', 'pkg', 'Quizzer-darwin-arm64.pkg'), 'mac installer');
    await writeFile(join(builds, 'mac', 'dmg', 'Quizzer-darwin-arm64.dmg'), 'mac disk image');
    await writeFile(join(builds, 'linux', 'deb', 'quizzer_amd64.deb'), 'linux artifact');
    await writeFile(join(builds, 'mac', 'quizzer'), 'mac cli');
    await writeFile(join(builds, 'linux', 'quizzer'), 'linux cli');
    await collectReleaseArtifacts({ sourceDirectory: join(builds, 'mac'), cliPath: join(builds, 'mac', 'quizzer'), outputDirectory: join(downloads, 'mac'), platform: 'macos', architecture: 'arm64', version: '1.0.0-beta.1' });
    await collectReleaseArtifacts({ sourceDirectory: join(builds, 'linux'), cliPath: join(builds, 'linux', 'quizzer'), outputDirectory: join(downloads, 'linux'), platform: 'linux', architecture: 'x64', version: '1.0.0-beta.1' });
    const merged = await mergeReleaseArtifacts({ inputDirectory: downloads, outputDirectory: join(directory, 'bundle') });
    assert.deepEqual(merged.artifacts.map(item => item.name).sort(), [
      'quizzer-1.0.0-beta.1-linux-x64.deb',
      'quizzer-1.0.0-beta.1-macos-arm64.dmg',
      'quizzer-1.0.0-beta.1-macos-arm64.pkg',
      'quizzer-1.0.0-beta.1-macos-arm64.zip',
      'quizzer-cli-1.0.0-beta.1-linux-x64',
      'quizzer-cli-1.0.0-beta.1-macos-arm64',
    ]);
    assert.equal(merged.artifacts.filter(item => item.cli).length, 2);
    assert.equal(JSON.parse(await readFile(merged.descriptorPath, 'utf8')).length, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normalizes and includes exactly one AppImage per Linux target across x64 and arm64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-appimage-artifacts-'));
  try {
    const builds = join(directory, 'builds');
    const downloads = join(directory, 'downloads');

    // Linux x64 builds: deb, rpm, zip, and AppImage
    const linuxX64 = join(builds, 'linux-x64');
    await mkdir(join(linuxX64, 'AppImage', 'x64'), { recursive: true });
    await mkdir(join(linuxX64, 'deb'), { recursive: true });
    await mkdir(join(linuxX64, 'rpm'), { recursive: true });
    await mkdir(join(linuxX64, 'zip'), { recursive: true });
    await writeFile(join(linuxX64, 'AppImage', 'x64', 'Quizzer-1.0.0-beta.1-x64.AppImage'), 'appimage x64 binary');
    await writeFile(join(linuxX64, 'deb', 'quizzer_1.0.0-beta.1_amd64.deb'), 'deb x64 package');
    await writeFile(join(linuxX64, 'rpm', 'quizzer-1.0.0.beta.1-1.x86_64.rpm'), 'rpm x64 package');
    await writeFile(join(linuxX64, 'zip', 'quizzer-linux-x64-1.0.0-beta.1.zip'), 'zip x64 archive');
    await writeFile(join(linuxX64, 'quizzer'), 'cli x64');

    // Linux arm64 builds: deb, rpm, zip, and AppImage
    const linuxArm64 = join(builds, 'linux-arm64');
    await mkdir(join(linuxArm64, 'AppImage', 'arm64'), { recursive: true });
    await mkdir(join(linuxArm64, 'deb'), { recursive: true });
    await mkdir(join(linuxArm64, 'rpm'), { recursive: true });
    await mkdir(join(linuxArm64, 'zip'), { recursive: true });
    await writeFile(join(linuxArm64, 'AppImage', 'arm64', 'Quizzer-1.0.0-beta.1-arm64.AppImage'), 'appimage arm64 binary');
    await writeFile(join(linuxArm64, 'deb', 'quizzer_1.0.0-beta.1_arm64.deb'), 'deb arm64 package');
    await writeFile(join(linuxArm64, 'rpm', 'quizzer-1.0.0.beta.1-1.aarch64.rpm'), 'rpm arm64 package');
    await writeFile(join(linuxArm64, 'zip', 'quizzer-linux-arm64-1.0.0-beta.1.zip'), 'zip arm64 archive');
    await writeFile(join(linuxArm64, 'quizzer'), 'cli arm64');

    const resultX64 = await collectReleaseArtifacts({
      sourceDirectory: linuxX64,
      cliPath: join(linuxX64, 'quizzer'),
      outputDirectory: join(downloads, 'linux-x64'),
      platform: 'linux',
      architecture: 'x64',
      version: '1.0.0-beta.1',
    });
    const resultArm64 = await collectReleaseArtifacts({
      sourceDirectory: linuxArm64,
      cliPath: join(linuxArm64, 'quizzer'),
      outputDirectory: join(downloads, 'linux-arm64'),
      platform: 'linux',
      architecture: 'arm64',
      version: '1.0.0-beta.1',
    });

    const appImageX64 = resultX64.artifacts.find(item => item.format === 'appimage');
    assert.ok(appImageX64, 'AppImage x64 artifact collected');
    assert.equal(appImageX64.name, 'quizzer-1.0.0-beta.1-linux-x64.appimage');
    assert.equal(appImageX64.platform, 'linux');
    assert.equal(appImageX64.architecture, 'x64');
    assert.equal(appImageX64.format, 'appimage');
    assert.equal(appImageX64.minimumOs, 'Current 64-bit Ubuntu or Fedora');

    const appImageArm64 = resultArm64.artifacts.find(item => item.format === 'appimage');
    assert.ok(appImageArm64, 'AppImage arm64 artifact collected');
    assert.equal(appImageArm64.name, 'quizzer-1.0.0-beta.1-linux-arm64.appimage');
    assert.equal(appImageArm64.platform, 'linux');
    assert.equal(appImageArm64.architecture, 'arm64');
    assert.equal(appImageArm64.format, 'appimage');
    assert.equal(appImageArm64.minimumOs, 'Current 64-bit Ubuntu or Fedora');

    const merged = await mergeReleaseArtifacts({
      inputDirectory: downloads,
      outputDirectory: join(directory, 'bundle'),
    });

    assert.deepEqual(merged.artifacts.map(item => item.name).sort(), [
      'quizzer-1.0.0-beta.1-linux-arm64.appimage',
      'quizzer-1.0.0-beta.1-linux-arm64.deb',
      'quizzer-1.0.0-beta.1-linux-arm64.rpm',
      'quizzer-1.0.0-beta.1-linux-arm64.zip',
      'quizzer-1.0.0-beta.1-linux-x64.appimage',
      'quizzer-1.0.0-beta.1-linux-x64.deb',
      'quizzer-1.0.0-beta.1-linux-x64.rpm',
      'quizzer-1.0.0-beta.1-linux-x64.zip',
      'quizzer-cli-1.0.0-beta.1-linux-arm64',
      'quizzer-cli-1.0.0-beta.1-linux-x64',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects duplicate AppImage artifacts for the same target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-duplicate-appimage-'));
  try {
    const builds = join(directory, 'builds');
    await mkdir(join(builds, 'first'), { recursive: true });
    await mkdir(join(builds, 'second'), { recursive: true });
    await writeFile(join(builds, 'first', 'Quizzer-1.0.0-x64.AppImage'), 'first');
    await writeFile(join(builds, 'second', 'Quizzer-alt-1.0.0-x64.appimage'), 'second');

    await assert.rejects(
      collectReleaseArtifacts({
        sourceDirectory: builds,
        outputDirectory: join(directory, 'out'),
        platform: 'linux',
        architecture: 'x64',
        version: '1.0.0-beta.1',
      }),
      /Multiple appimage artifacts were produced for linux\/x64/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
