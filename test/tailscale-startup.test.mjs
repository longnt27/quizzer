import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { authenticatedRuntimeEnvironment } from '../scripts/runtime.mjs';
import { configureServiceProxy } from '../scripts/vite-proxy.mjs';
import { findTailscaleAddress, isTailscaleIPv4 } from '../scripts/tailscale-address.mjs';
import { databasePathFor, defaultAppDataDirectory } from '../server/paths.mjs';

test('default app data is native user data, not the source repository', () => {
  const appData = defaultAppDataDirectory({ platform: 'linux', environment: {}, home: homedir() });
  assert.notEqual(resolve(appData), resolve(process.cwd(), '.quizzer-data'));
  assert.equal(databasePathFor(appData), join(appData, 'data', 'quizzer.sqlite'));
});

test('authenticated launch keeps the token out of the renderer environment', async () => {
  const appData = await mkdtemp(join(tmpdir(), 'quizzer-tailscale-startup-'));
  try {
    const database = join(appData, 'custom.sqlite');
    const environment = await authenticatedRuntimeEnvironment({
      PATH: process.env.PATH,
      QUIZZER_APP_DATA_DIR: appData,
      QUIZZER_DATABASE_PATH: database,
    });
    assert.equal(environment.QUIZZER_DATABASE_PATH, database);
    assert.equal(Object.hasOwn(environment, 'VITE_QUIZZER_API_TOKEN'), false);
    assert.equal((await stat(join(appData, 'service-token'))).mode & 0o777, 0o600);
    const token = await readFile(join(appData, 'service-token'), 'utf8');
    assert.equal(environment.QUIZZER_API_TOKEN, token.trim());
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});

test('Vite API proxy injects the service bearer token over incoming authorization', () => {
  const listeners = new Map();
  const proxy = { on: (event, listener) => listeners.set(event, listener) };
  configureServiceProxy(proxy, '  server-secret-token  ');
  const headers = new Map([['authorization', 'Bearer remote-token']]);
  listeners.get('proxyReq')({
    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
  });
  assert.equal(headers.get('authorization'), 'Bearer server-secret-token');
});

test('Vite API proxy leaves unauthenticated development requests unchanged', () => {
  let configured = false;
  configureServiceProxy({ on: () => { configured = true; } }, undefined);
  assert.equal(configured, false);
});

test('Tailscale address lookup accepts only CGNAT tailnet IPv4 addresses', () => {
  assert.equal(isTailscaleIPv4('100.64.0.1'), true);
  assert.equal(isTailscaleIPv4('100.127.255.254'), true);
  assert.equal(isTailscaleIPv4('100.63.0.1'), false);
  assert.equal(isTailscaleIPv4('192.168.1.2'), false);
  assert.equal(findTailscaleAddress({
    run: () => '192.168.1.2\n100.96.1.2\n',
    interfaces: {},
  }), '100.96.1.2');
  assert.equal(findTailscaleAddress({
    run: () => { throw new Error('tailscale unavailable'); },
    interfaces: { en0: [{ family: 'IPv4', address: '100.110.1.2' }] },
  }), '100.110.1.2');
});
