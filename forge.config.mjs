import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerPKG } from '@electron-forge/maker-pkg';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { join, resolve } from 'node:path';

export const electronFuseConfig = Object.freeze({
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

export const electronExecutableForBuild = (buildPath, platform) => {
  const basePath = resolve(buildPath, '../..');
  if (platform === 'darwin' || platform === 'mas') return join(basePath, 'MacOS', 'Electron');
  return join(basePath, platform === 'win32' ? 'electron.exe' : 'electron');
};

const platformIcon = process.platform === 'darwin'
  ? 'assets/icons/quizzer.icns'
  : process.platform === 'win32'
    ? 'assets/icons/quizzer.ico'
    : 'assets/icons/quizzer.png';

export default {
  packagerConfig: {
    asar: { unpack: '**/*.{node,dll,dylib,so}' },
    executableName: process.platform === 'darwin' ? 'Quizzer' : 'quizzer',
    appBundleId: 'dev.quizzer.app',
    appCategoryType: 'public.app-category.education',
    icon: platformIcon,
    extraResource: ['scripts/ocr_image.py'],
    ignore: [
      /^\/landing($|\/)/,
      /^\/src($|\/)/,
      /^\/docs($|\/)/,
      /^\/eval($|\/)/,
      /^\/test($|\/)/,
      /^\/\.quizzer/,
      /^\/out($|\/)/,
      /^\/certificate\.(?:p12|pfx)$/,
    ],
    osxSign: process.env.APPLE_IDENTITY ? { identity: process.env.APPLE_IDENTITY, hardenedRuntime: true } : undefined,
    osxNotarize: process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    } : undefined,
    windowsSign: process.env.WINDOWS_CERTIFICATE_FILE ? {
      certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
      certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
      description: 'Quizzer',
    } : undefined,
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (forgeConfig, buildPath, _electronVersion, platform, arch) => {
      const signedByForge = Boolean(forgeConfig.packagerConfig.osxSign);
      await flipFuses(electronExecutableForBuild(buildPath, platform), {
        ...electronFuseConfig,
        resetAdHocDarwinSignature: platform === 'darwin' && arch === 'arm64' && !signedByForge,
      });
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'quizzer', setupIcon: 'assets/icons/quizzer.ico',
      windowsSign: process.env.WINDOWS_CERTIFICATE_FILE ? {
        certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
        certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
        description: 'Quizzer',
      } : undefined,
    }),
    new MakerZIP({}, ['darwin', 'linux']),
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    new MakerPKG({
      identity: process.env.APPLE_INSTALLER_IDENTITY || process.env.APPLE_IDENTITY,
    }, ['darwin']),
    new MakerDeb({ options: { name: 'quizzer', productName: 'Quizzer', icon: 'assets/icons/quizzer.png', categories: ['Education'] } }),
    new MakerRpm({ options: { name: 'quizzer', productName: 'Quizzer', icon: 'assets/icons/quizzer.png', categories: ['Education'] } }),
  ],
};
