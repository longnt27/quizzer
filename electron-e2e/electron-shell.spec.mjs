import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronExecutableFromPackage } from '../scripts/electron-shell-platform.mjs';

const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const electronExecutable = electronExecutableFromPackage(() => require('electron'));

test.describe('Quizzer desktop shell', () => {
  let app;
  let userDataDirectory;

  test.beforeEach(async () => {
    userDataDirectory = await mkdtemp(join(tmpdir(), 'quizzer-electron-smoke-'));
    app = await electron.launch({
      args: [projectDirectory, '--disable-gpu'],
      cwd: projectDirectory,
      executablePath: electronExecutable,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        QUIZZER_USER_DATA_DIR: userDataDirectory,
        QUIZZER_APP_DATA_DIR: userDataDirectory,
        QUIZZER_DISABLE_SERVICE_GENERATION: '1',
        QUIZZER_SERVICE_PORT: '0',
        QUIZZER_RENDERER_URL: '',
        QUIZZER_EXTERNAL_SERVICE_PORT: '',
      },
    });
  });

  test.afterEach(async () => {
    if (app) {
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await app.close();
      app = undefined;
    }
    if (userDataDirectory) {
      assert.equal(existsSync(userDataDirectory), true, 'the shell should create isolated app data before cleanup');
      await rm(userDataDirectory, { recursive: true, force: true });
      assert.equal(existsSync(userDataDirectory), false, 'the isolated app data directory should be removed after shutdown');
    }
  });

  test('loads the real custom-protocol renderer with a narrow isolated preload and navigates Home', async () => {
    const page = await app.firstWindow();
    await expect(page).toHaveURL('quizzer://app/');
    await expect(page.getByRole('heading', { name: 'Welcome to Quizzer' })).toBeVisible();

    const rendererSurface = await page.evaluate(() => ({
      nodeIntegrationVisible: typeof process !== 'undefined' || typeof require !== 'undefined',
      desktopKeys: Object.keys(window.quizzerDesktop ?? {}).sort(),
      desktopFrozen: Object.isFrozen(window.quizzerDesktop),
      versionsFrozen: Object.isFrozen(window.quizzerDesktop?.versions),
      credentialsFrozen: Object.isFrozen(window.quizzerDesktop?.credentials),
      updaterFrozen: Object.isFrozen(window.quizzerDesktop?.updater),
      ipcRendererVisible: 'ipcRenderer' in window,
      origin: window.location.origin,
    }));
    assert.equal(rendererSurface.nodeIntegrationVisible, false);
    assert.deepEqual(rendererSurface.desktopKeys, [
      'architecture',
      'credentials',
      'platform',
      'selectPluginDirectory',
      'updater',
      'versions',
    ]);
    assert.equal(rendererSurface.desktopFrozen, true);
    assert.equal(rendererSurface.versionsFrozen, true);
    assert.equal(rendererSurface.credentialsFrozen, true);
    assert.equal(rendererSurface.updaterFrozen, true);
    assert.equal(rendererSurface.ipcRendererVisible, false);
    assert.equal(rendererSurface.origin, 'quizzer://app');

    const webPreferences = await app.evaluate(({ BrowserWindow }) => {
      const currentWindow = BrowserWindow.getAllWindows()[0];
      return currentWindow.webContents.getLastWebPreferences();
    });
    assert.equal(webPreferences.nodeIntegration, false);
    assert.equal(webPreferences.contextIsolation, true);
    assert.equal(webPreferences.sandbox, true);
    assert.equal(webPreferences.webSecurity, true);

    await page.locator('.onboarding-drawer .ant-drawer-close').click();
    await expect(page.locator('.onboarding-drawer')).toBeHidden();
    const documentsTab = page.locator('.desktop-sidebar').getByRole('tab', { name: 'Documents' });
    await documentsTab.click();
    await expect(page.getByText('No documents yet')).toBeVisible();
    await page.locator('.desktop-sidebar button').filter({ hasText: /^Home$/ }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to Quizzer' })).toBeVisible();
  });
});
