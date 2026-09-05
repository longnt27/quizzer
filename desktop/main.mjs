import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, net, protocol, safeStorage, shell, utilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureServiceToken } from '../server/auth.mjs';
import { CredentialVault } from './credential-vault.mjs';
import { waitForServiceReady } from './service-process.mjs';

protocol.registerSchemesAsPrivileged([{ scheme: 'quizzer', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (process.env.QUIZZER_USER_DATA_DIR) app.setPath('userData', process.env.QUIZZER_USER_DATA_DIR);

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(sourceDirectory, '..');
const rendererDirectory = join(projectDirectory, 'dist');
const developmentUrl = process.env.QUIZZER_RENDERER_URL;
let service;
let serviceToken;
let servicePort;
let window;
let tray;
let quitting = false;
let credentialVault;

const isAllowedExternalUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
};

const isTrustedRenderer = event => {
  try {
    const rendererUrl = new URL(event.senderFrame.url);
    return developmentUrl
      ? rendererUrl.origin === new URL(developmentUrl).origin
      : rendererUrl.protocol === 'quizzer:' && rendererUrl.hostname === 'app';
  } catch { return false; }
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
    return credentialVault.set(provider, value);
  });
  ipcMain.handle('credentials:delete', async (event, provider) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer');
    return credentialVault.delete(provider);
  });
};

const startService = async () => {
  const userData = app.getPath('userData');
  serviceToken = await ensureServiceToken(userData);
  const requestedPort = process.env.QUIZZER_DESKTOP_SERVICE_PORT ?? (developmentUrl ? '8787' : '0');
  service = utilityProcess.fork(join(projectDirectory, 'server.mjs'), [], {
    cwd: userData,
    env: {
      ...process.env,
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
  const readiness = waitForServiceReady(service);
  service.on('spawn', () => process.stdout.write('Quizzer local service started\n'));
  service.on('exit', code => {
    if (!quitting && code !== 0) process.stderr.write(`Quizzer local service stopped (${code})\n`);
  });
  servicePort = await readiness;
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
    const allowedOrigin = developmentUrl ? new URL(developmentUrl).origin : 'quizzer://app';
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.once('ready-to-show', () => window?.show());
  void window.loadURL(developmentUrl || 'quizzer://app/');
};

const createTray = () => {
  const icon = nativeImage.createFromPath(join(projectDirectory, 'public', 'quizzer.svg')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Quizzer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Quizzer', click: () => { window?.show(); window?.focus(); } },
    { type: 'separator' },
    { label: 'Quit Quizzer', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { window?.show(); window?.focus(); });
};

app.whenReady().then(async () => {
  credentialVault = new CredentialVault(join(app.getPath('userData'), 'credentials.json'), safeStorage);
  await startService();
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
app.on('before-quit', () => { quitting = true; service?.kill(); });
app.on('window-all-closed', () => {
  // The renderer currently owns active generation, so it remains alive in the tray.
});
