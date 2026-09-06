import assert from 'node:assert/strict';
import test from 'node:test';
import forgeConfig from '../forge.config.mjs';

test('configures deterministic macOS distributables', () => {
  const makers = forgeConfig.makers;
  
  const dmg = makers.find(m => m.name === 'dmg');
  assert.ok(dmg, 'MakerDMG is configured');
  assert.deepEqual(dmg.platformsToMakeOn, ['darwin'], 'MakerDMG is strictly bound to macOS');
  assert.equal(dmg.configOrConfigFetcher.format, 'ULFO', 'MakerDMG uses standard compression');

  const pkg = makers.find(m => m.name === 'pkg');
  assert.ok(pkg, 'MakerPKG is configured');
  assert.deepEqual(pkg.platformsToMakeOn, ['darwin'], 'MakerPKG is strictly bound to macOS');
  assert.ok('identity' in pkg.configOrConfigFetcher, 'MakerPKG explicitly configures identity for signing');

  const zip = makers.find(m => m.name === 'zip');
  assert.ok(zip, 'MakerZIP is configured');
  assert.ok(zip.platformsToMakeOn.includes('darwin'), 'MakerZIP retains darwin support for updates');
  
  // ensure no ambiguous or unsupported makers are added for macos
  const darwinMakers = makers.filter(m => {
    const platforms = m.platformsToMakeOn || m.defaultPlatforms;
    return platforms.includes('darwin');
  });
  assert.equal(darwinMakers.length, 3, 'Exactly three darwin makers are configured for unambiguous artifact collection');
});
