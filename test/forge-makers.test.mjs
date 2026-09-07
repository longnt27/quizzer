import assert from 'node:assert/strict';
import test from 'node:test';
import forgeConfig from '../forge.config.mjs';

test('configures deterministic macOS distributables', () => {
  const makers = forgeConfig.makers;

  const dmg = makers.find(m => m.name === 'dmg');
  assert.ok(dmg, 'MakerDMG is configured');
  assert.deepEqual(dmg.platformsToMakeOn, ['darwin'], 'MakerDMG is strictly bound to macOS');
  assert.equal(dmg.configOrConfigFetcher.format, 'ULFO', 'MakerDMG uses standard compression');

  assert.equal(makers.some(maker => maker.name === 'pkg'), false, 'unsigned development builds do not attempt a PKG');

  const zip = makers.find(m => m.name === 'zip');
  assert.ok(zip, 'MakerZIP is configured');
  assert.ok(zip.platformsToMakeOn.includes('darwin'), 'MakerZIP retains darwin support for updates');

  const darwinMakers = makers.filter(m => {
    const platforms = m.platformsToMakeOn || m.defaultPlatforms;
    return platforms.includes('darwin');
  });
  assert.equal(darwinMakers.length, 2, 'Unsigned builds make only ZIP and DMG artifacts');
});

test('uses distinct application and installer signing identities', async () => {
  const previousApplication = process.env.APPLE_IDENTITY;
  const previousInstaller = process.env.APPLE_INSTALLER_IDENTITY;
  try {
    process.env.APPLE_IDENTITY = 'Developer ID Application: Quizzer (TEAM123)';
    process.env.APPLE_INSTALLER_IDENTITY = 'Developer ID Installer: Quizzer (TEAM123)';
    const signedConfig = (await import(`../forge.config.mjs?signing=${Date.now()}`)).default;
    const dmg = signedConfig.makers.find(maker => maker.name === 'dmg');
    const pkg = signedConfig.makers.find(maker => maker.name === 'pkg');
    assert.ok(pkg, 'signed release builds configure MakerPKG');
    assert.deepEqual(pkg.platformsToMakeOn, ['darwin']);
    assert.equal(
      dmg.configOrConfigFetcher.additionalDMGOptions['code-sign']['signing-identity'],
      process.env.APPLE_IDENTITY,
    );
    assert.equal(pkg.configOrConfigFetcher.identity, process.env.APPLE_INSTALLER_IDENTITY);
    const darwinMakers = signedConfig.makers.filter(maker => {
      const platforms = maker.platformsToMakeOn || maker.defaultPlatforms;
      return platforms.includes('darwin');
    });
    assert.equal(darwinMakers.length, 3, 'Signed releases make ZIP, DMG, and PKG artifacts');
  } finally {
    if (previousApplication === undefined) delete process.env.APPLE_IDENTITY;
    else process.env.APPLE_IDENTITY = previousApplication;
    if (previousInstaller === undefined) delete process.env.APPLE_INSTALLER_IDENTITY;
    else process.env.APPLE_INSTALLER_IDENTITY = previousInstaller;
  }
});

test('configures deterministic Linux distributables including AppImage with platform gating', () => {
  const makers = forgeConfig.makers;

  const appImage = makers.find(m => m.name === 'AppImage');
  assert.ok(appImage, 'MakerAppImage is configured');
  assert.deepEqual(appImage.platformsToMakeOn, ['linux'], 'MakerAppImage is strictly bound to Linux');
  assert.equal(appImage.configOrConfigFetcher.options.name, 'quizzer');
  assert.equal(appImage.configOrConfigFetcher.options.productName, 'Quizzer');
  assert.equal(appImage.configOrConfigFetcher.options.icon, 'assets/icons/quizzer.png');
  assert.deepEqual(appImage.configOrConfigFetcher.options.categories, ['Education']);

  const deb = makers.find(m => m.name === 'deb');
  assert.ok(deb, 'MakerDeb is configured');
  const rpm = makers.find(m => m.name === 'rpm');
  assert.ok(rpm, 'MakerRpm is configured');
  const zip = makers.find(m => m.name === 'zip');
  assert.ok(zip, 'MakerZIP is configured');

  const linuxMakers = makers.filter(m => {
    const platforms = m.platformsToMakeOn || m.defaultPlatforms;
    return platforms.includes('linux');
  });
  assert.equal(linuxMakers.length, 4, 'Linux distributables include deb, rpm, zip, and AppImage');

  const darwinMakers = makers.filter(m => {
    const platforms = m.platformsToMakeOn || m.defaultPlatforms;
    return platforms.includes('darwin');
  });
  assert.equal(darwinMakers.some(m => m.name === 'AppImage'), false, 'AppImage is gated away from macOS');

  const winMakers = makers.filter(m => {
    const platforms = m.platformsToMakeOn || m.defaultPlatforms;
    return platforms.includes('win32');
  });
  assert.equal(winMakers.some(m => m.name === 'AppImage'), false, 'AppImage is gated away from Windows');
});
