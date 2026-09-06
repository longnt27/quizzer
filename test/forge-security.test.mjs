import assert from 'node:assert/strict';
import test from 'node:test';
import { FuseVersion, FuseV1Options } from '@electron/fuses';
import forgeConfig from '../forge.config.mjs';

test('packages application code in an ASAR archive', () => {
  assert.deepEqual(forgeConfig.packagerConfig.asar, {
    unpack: '**/*.{node,dll,dylib,so}',
  });
});

test('locks security-sensitive Electron fuses in packaged builds', () => {
  const fusePlugin = forgeConfig.plugins.find(plugin => plugin.name === 'fuses');
  assert.ok(fusePlugin, 'Electron Forge must include the fuses plugin');

  assert.deepEqual(fusePlugin.fusesConfig, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
});
