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
