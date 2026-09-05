import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';

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
    ignore: [/^\/landing($|\/)/, /^\/src($|\/)/, /^\/docs($|\/)/, /^\/test($|\/)/, /^\/\.quizzer/, /^\/out($|\/)/],
    osxSign: process.env.APPLE_IDENTITY ? { identity: process.env.APPLE_IDENTITY, hardenedRuntime: true } : undefined,
    osxNotarize: process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    } : undefined,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'quizzer', setupIcon: 'assets/icons/quizzer.ico' }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({ options: { name: 'quizzer', productName: 'Quizzer', icon: 'assets/icons/quizzer.png', categories: ['Education'] } }),
    new MakerRpm({ options: { name: 'quizzer', productName: 'Quizzer', icon: 'assets/icons/quizzer.png', categories: ['Education'] } }),
  ],
};
