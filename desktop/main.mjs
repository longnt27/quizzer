import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, net, protocol, safeStorage, shell, utilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureServiceToken } from '../server/auth.mjs';
import { CredentialVault } from './credential-vault.mjs';
import { isAllowedExternalUrl, isTrustedRendererUrl } from './security.mjs';
import { executableSearchPath, serviceRestartDelay, waitForServiceReady } from './service-process.mjs';
import { protectedBackgroundFallback, summarizeBackgroundState } from './background-policy.mjs';
import { DesktopUpdater } from './updater.mjs';
import { validateAutoDownloadPreference, validateUpdaterCheckOptions, validateUpdaterApplyOptions } from './updater-ipc.mjs';
import { RELEASE_TRUSTED_KEYS } from '../release/trust.mjs';

protocol.registerSchemesAsPrivileged([{ scheme: 'quizzer', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (process.env.QUIZZER_USER_DATA_DIR) app.setPath('userData', process.env.QUIZZER_USER_DATA_DIR);

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(sourceDirectory, '..');
const rendererDirectory = join(projectDirectory, 'dist');
const developmentUrl = app.isPackaged ? undefined : process.env.QUIZZER_RENDERER_URL;
const externalDevelopmentPort = developmentUrl ? process.env.QUIZZER_EXTERNAL_SERVICE_PORT : undefined;
let service;
let serviceToken;
let servicePort;
let window;
let tray;
let quitting = false;
let credentialVault;
let desktopUpdater;
let serviceRecoveryEnabled = false;
let serviceRestartAttempt = 0;
let serviceRestartTimer;
let serviceStableTimer;
let trayRefreshTimer;
let closeDecisionPending = false;

const syncServiceCredentials = async () => {
  if (!credentialVault || !servicePort || !serviceToken) return;
  const values = await credentialVault.list();
  if (service?.postMessage) {
    service.postMessage({ type: 'quizzer-provider-credentials', values });
    return;
  }
  const response = await net.fetch(`http://127.0.0.1:${servicePort}/api/v1/provider-credentials`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!response.ok) throw new Error(`Could not hand credentials to the local service (${response.status})`);
};

const isTrustedRenderer = event => {
  return isTrustedRendererUrl(event.senderFrame.url, developmentUrl);
};

const registerValidatedIpc = () => {
  ipcMain.handle('plugins:select-directory', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const result = await dialog.showOpenDialog(window, {
      title: 'Select a Quizzer plugin directory',
      properties: ['openDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('credentials:status', event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return credentialVault.status();
  });
  ipcMain.handle('credentials:list', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return credentialVault.list();
  });
  ipcMain.handle('credentials:set', async (event, provider, value) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const result = await credentialVault.set(provider, value);
    await syncServiceCredentials();
    return result;
  });
  ipcMain.handle('credentials:delete', async (event, provider) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const result = await credentialVault.delete(provider);
    await syncServiceCredentials();
    return result;
  });
  ipcMain.handle('updater:status', event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return desktopUpdater?.getStatus();
  });
  ipcMain.handle('updater:check', async (event, options) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const validated = validateUpdaterCheckOptions(options);
    return desktopUpdater?.checkForUpdates(validated);
  });
  ipcMain.handle('updater:download', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return desktopUpdater?.downloadUpdate();
  });
  ipcMain.handle('updater:set-auto-download', async (event, enabled) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return desktopUpdater?.setAutoDownload(validateAutoDownloadPreference(enabled));
  });
  ipcMain.handle('updater:apply', async (event, options) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const validated = validateUpdaterApplyOptions(options);
    const result = await desktopUpdater?.applyUpdate(validated);
    if (result?.restartRequested && result.mechanism === 'staged-ready') {
      setTimeout(() => quitApplication(), 500);
    }
    return result;
  });
  ipcMain.handle('updater:discard', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return desktopUpdater?.discardUpdate();
  });
  ipcMain.handle('updater:rollback', async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    const result = await desktopUpdater?.rollbackUpdate();
    if (result?.quitRequested && result.mechanism === 'staged-ready') {
      setTimeout(() => quitApplication(), 500);
    }
    return result;
  });
};

const scheduleServiceRestart = () => {
  if (quitting || !serviceRecoveryEnabled || serviceRestartTimer) return;
  const delay = serviceRestartDelay(serviceRestartAttempt);
  serviceRestartAttempt += 1;
  process.stderr.write(`Restarting Quizzer local service in ${Math.ceil(delay / 1000)} seconds\n`);
  serviceRestartTimer = setTimeout(() => {
    serviceRestartTimer = undefined;
    void startService().catch(error => {
      process.stderr.write(`Quizzer local service restart failed: ${error instanceof Error ? error.message : String(error)}\n`);
      scheduleServiceRestart();
    });
  }, delay);
};

const startService = async () => {
  const userData = app.getPath('userData');
  serviceToken = await ensureServiceToken(userData);
  if (externalDevelopmentPort !== undefined) {
    const port = Number(externalDevelopmentPort);
    if (!/^\d{1,5}$/.test(externalDevelopmentPort) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('QUIZZER_EXTERNAL_SERVICE_PORT must be an integer from 1 to 65535');
    }
    servicePort = port;
    return;
  }
  const requestedPort = process.env.QUIZZER_DESKTOP_SERVICE_PORT ?? (developmentUrl ? '8787' : '0');
  const child = utilityProcess.fork(join(projectDirectory, 'server.mjs'), [], {
    cwd: userData,
    env: {
      ...process.env,
      PATH: executableSearchPath(process.env, { homeDirectory: app.getPath('home') }),
      QUIZZER_APP_DATA_DIR: userData,
      QUIZZER_DATABASE_PATH: join(userData, 'data', 'quizzer.sqlite'),
      QUIZZER_RESOURCE_DIR: app.isPackaged ? process.resourcesPath : projectDirectory,
      QUIZZER_OCR_SCRIPT: app.isPackaged
        ? join(process.resourcesPath, 'ocr_image.py')
        : join(projectDirectory, 'scripts', 'ocr_image.py'),
      QUIZZER_API_TOKEN: serviceToken,
      QUIZZER_SERVICE_PORT: requestedPort,
    },
    stdio: 'inherit',
    serviceName: 'Quizzer local service',
  });
  service = child;
  const readiness = waitForServiceReady(child);
  child.on('spawn', () => process.stdout.write('Quizzer local service started\n'));
  child.on('exit', code => {
    if (service !== child) return;
    servicePort = undefined;
    clearTimeout(serviceStableTimer);
    if (!quitting) {
      process.stderr.write(`Quizzer local service stopped (${code})\n`);
      scheduleServiceRestart();
    }
  });
  try {
    servicePort = await readiness;
  } catch (error) {
    child.kill();
    throw error;
  }
  clearTimeout(serviceStableTimer);
  serviceStableTimer = setTimeout(() => { serviceRestartAttempt = 0; }, 60_000);
  await syncServiceCredentials();
};

const registerApplicationProtocol = () => protocol.handle('quizzer', request => {
  const url = new URL(request.url);
  if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
  if (url.pathname.startsWith('/api/')) {
    if (!servicePort) return new Response('Service unavailable', { status: 503 });
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${serviceToken}`);
    return net.fetch(`http://127.0.0.1:${servicePort}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      duplex: 'half',
    });
  }

  let relativePath;
  try { relativePath = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)); }
  catch { return new Response('Invalid path', { status: 400 }); }
  if (relativePath.includes('\0') || relativePath.includes('\\')) return new Response('Invalid path', { status: 400 });
  const requestedPath = normalize(join(rendererDirectory, relativePath));
  if (!requestedPath.startsWith(`${rendererDirectory}${sep}`) && requestedPath !== rendererDirectory) return new Response('Not found', { status: 404 });
  const filePath = existsSync(requestedPath) && extname(requestedPath) ? requestedPath : join(rendererDirectory, 'index.html');
  return net.fetch(pathToFileURL(filePath).toString());
});

const serviceJson = async path => {
  if (!servicePort || !serviceToken) throw new Error('Local service is unavailable');
  const response = await net.fetch(`http://127.0.0.1:${servicePort}${path}`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local service returned ${response.status}`);
  return payload;
};

const loadBackgroundState = async () => {
  try {
    const [settings, generation, indexing] = await Promise.all([
      serviceJson('/api/v1/settings'),
      serviceJson('/api/v1/jobs'),
      serviceJson('/api/v1/index/jobs'),
    ]);
    return summarizeBackgroundState({
      settings: settings.values,
      generationJobs: generation.jobs,
      indexJobs: indexing.jobs,
    });
  } catch {
    return protectedBackgroundFallback;
  }
};

const quitApplication = () => {
  quitting = true;
  app.quit();
};

const updateTray = state => {
  if (!tray || tray.isDestroyed()) return;
  const workLabel = state.activeJobCount
    ? `${state.activeJobCount} active job${state.activeJobCount === 1 ? '' : 's'}${state.runningJobs ? ` · ${state.runningJobs} running` : ''}`
    : state.serviceUnavailable ? 'Protecting background work · service reconnecting' : 'No active jobs';
  tray.setToolTip(state.activeJobCount ? `Quizzer · ${workLabel}` : 'Quizzer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Quizzer', click: () => { window?.show(); window?.focus(); } },
    { label: workLabel, enabled: false },
    { type: 'separator' },
    { label: 'Quit Quizzer', click: quitApplication },
  ]));
};

const refreshTray = async () => updateTray(await loadBackgroundState());

const createWindow = () => {
  window = new BrowserWindow({
    title: 'Quizzer',
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#101214',
    show: false,
    webPreferences: {
      preload: join(sourceDirectory, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, developmentUrl)) event.preventDefault();
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.setDevicePermissionHandler?.(() => false);
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (closeDecisionPending) return;
    closeDecisionPending = true;
    void loadBackgroundState().then(state => {
      if (quitting) return;
      if (state.continueInBackground) window?.hide();
      else quitApplication();
    }).finally(() => { closeDecisionPending = false; });
  });
  window.once('ready-to-show', () => window?.show());
  void window.loadURL(developmentUrl || 'quizzer://app/');
};

const createTray = () => {
  const icon = nativeImage.createFromPath(join(projectDirectory, 'public', 'quizzer.svg')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  updateTray(protectedBackgroundFallback);
  tray.on('click', () => { window?.show(); window?.focus(); });
  void refreshTray();
  trayRefreshTimer = setInterval(() => void refreshTray(), 5_000);
};

app.whenReady().then(async () => {
  // Quizzer exposes its supported navigation inside the application. Removing
  // Electron's default menu also prevents production users from invoking
  // renderer reload, zoom, and developer-tool actions.
  Menu.setApplicationMenu(null);
  credentialVault = new CredentialVault(join(app.getPath('userData'), 'credentials.json'), safeStorage);
  desktopUpdater = new DesktopUpdater({
    userDataDir: app.getPath('userData'),
    currentVersion: app.getVersion() || '1.0.0-beta.5',
    isPackaged: app.isPackaged,
    applicationPath: dirname(dirname(dirname(app.getPath('exe')))),
    currentPid: process.pid,
    fetch: net.fetch,
    trustedKeys: RELEASE_TRUSTED_KEYS,
  });
  await startService();
  serviceRecoveryEnabled = externalDevelopmentPort === undefined;
  if (!servicePort) scheduleServiceRestart();
  if (!developmentUrl) void registerApplicationProtocol();
  registerValidatedIpc();
  createWindow();
  createTray();
}).catch(error => {
  process.stderr.write(`Quizzer could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  quitting = true;
  app.quit();
});

app.on('activate', () => window ? window.show() : createWindow());
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(serviceRestartTimer);
  clearTimeout(serviceStableTimer);
  clearInterval(trayRefreshTimer);
  service?.kill();
});
app.on('window-all-closed', () => {
  // The renderer currently owns active generation, so it remains alive in the tray.
});
