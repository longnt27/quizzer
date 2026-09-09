import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FuseVersion, FuseV1Options } from '@electron/fuses';
import forgeConfig, { electronExecutableForBuild, electronFuseConfig } from '../forge.config.mjs';

test('packages the complete built-in vector index dependency graph', async () => {
  const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageMetadata.dependencies['apache-arrow'], '^18.1.0');
});

test('packages application code in an ASAR archive', () => {
  assert.deepEqual(forgeConfig.packagerConfig.asar, {
    unpack: '**/*.{node,dll,dylib,so}',
  });
  assert.ok(forgeConfig.packagerConfig.ignore.some(pattern => pattern.test('/eval/rag/en.json')));
});

test('locks security-sensitive Electron fuses in packaged builds', () => {
  assert.equal(typeof forgeConfig.hooks.packageAfterCopy, 'function');
  assert.deepEqual(electronFuseConfig, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  });
  assert.match(electronExecutableForBuild('/tmp/Quizzer.app/Contents/Resources/app', 'darwin'), /Quizzer\.app\/Contents\/MacOS\/Electron$/);
  assert.match(electronExecutableForBuild('/tmp/quizzer/resources/app', 'win32'), /quizzer[\\/]electron\.exe$/);
  assert.match(electronExecutableForBuild('/tmp/quizzer/resources/app', 'linux'), /quizzer[\\/]electron$/);
});
