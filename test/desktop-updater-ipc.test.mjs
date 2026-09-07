import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isTrustedRendererUrl } from '../desktop/security.mjs';

import {
  validateUpdaterApplyOptions,
  validateUpdaterChannel,
  validateUpdaterCheckOptions,
} from '../desktop/updater-ipc.mjs';

test('renderer origin verification rejects untrusted origins from accessing updater IPC', () => {
  assert.equal(isTrustedRendererUrl('quizzer://app/'), true);
  assert.equal(isTrustedRendererUrl('quizzer://app/settings'), true);

  assert.equal(isTrustedRendererUrl('https://evil.com'), false);
  assert.equal(isTrustedRendererUrl('quizzer://evil/'), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:8787/'), false);
  assert.equal(isTrustedRendererUrl('javascript:alert(1)'), false);
  assert.equal(isTrustedRendererUrl('file:///etc/passwd'), false);
});

test('updater IPC check handler validates channel and rejects unknown options or repository', () => {
  // Valid options
  assert.deepEqual(validateUpdaterCheckOptions(), {});
  assert.deepEqual(validateUpdaterCheckOptions({ channel: 'stable' }), { channel: 'stable' });
  assert.deepEqual(validateUpdaterCheckOptions({ channel: 'beta' }), { channel: 'beta' });
  assert.deepEqual(
    validateUpdaterCheckOptions({ channel: 'beta', preferredFormat: 'zip', force: true }),
    { channel: 'beta', preferredFormat: 'zip', force: true },
  );

  // Rejection of repository and manifestUrl (renderer must never control repository or URL)
  assert.throws(() => validateUpdaterCheckOptions({ repository: 'owner/repo' }), /Unknown option "repository" for updater:check/);
  assert.throws(() => validateUpdaterCheckOptions({ manifestUrl: 'https://evil.com/manifest.json' }), /Unknown option "manifestUrl" for updater:check/);
  assert.throws(() => validateUpdaterCheckOptions({ extra: 'value' }), /Unknown option "extra" for updater:check/);

  // Invalid option types
  assert.throws(() => validateUpdaterCheckOptions('invalid'), /Invalid options for updater:check/);
  assert.throws(() => validateUpdaterCheckOptions([1, 2, 3]), /Invalid options for updater:check/);
  assert.throws(() => validateUpdaterCheckOptions(null), /Invalid options for updater:check/);
  assert.throws(() => validateUpdaterCheckOptions({ channel: 'nightly' }), /Channel must be stable or beta/);
  assert.throws(() => validateUpdaterCheckOptions({ channel: 123 }), /Channel must be stable or beta/);
  assert.throws(() => validateUpdaterCheckOptions({ preferredFormat: '' }), /preferredFormat must be a non-empty string/);
  assert.throws(() => validateUpdaterCheckOptions({ force: 'yes' }), /force must be a boolean/);
});

test('updater IPC channel validator validates channel', () => {
  assert.equal(validateUpdaterChannel('stable'), 'stable');
  assert.equal(validateUpdaterChannel('beta'), 'beta');
  assert.throws(() => validateUpdaterChannel('nightly'), /Channel must be stable or beta/);
  assert.throws(() => validateUpdaterChannel(null), /Channel must be stable or beta/);
});

test('updater IPC apply handler strictly validates restart boolean parameter and rejects unknown options', () => {
  assert.deepEqual(validateUpdaterApplyOptions(), {});
  assert.deepEqual(validateUpdaterApplyOptions({ restart: true }), { restart: true });
  assert.deepEqual(validateUpdaterApplyOptions({ restart: false }), { restart: false });

  assert.throws(() => validateUpdaterApplyOptions('true'), /Invalid options for updater:apply/);
  assert.throws(() => validateUpdaterApplyOptions(null), /Invalid options for updater:apply/);
  assert.throws(() => validateUpdaterApplyOptions({ restart: 'true' }), /restart must be a boolean/);
  assert.throws(() => validateUpdaterApplyOptions({ restart: 1 }), /restart must be a boolean/);
  assert.throws(() => validateUpdaterApplyOptions({ unknownKey: true }), /Unknown option "unknownKey" for updater:apply/);
});

test('preload script exports only frozen, context-isolated updater surface', async () => {
  const preloadSource = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');

  // Verify contextBridge.exposeInMainWorld is used
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld/);

  // Verify quizzerDesktop is frozen
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('quizzerDesktop',\s*Object\.freeze\(/);

  // Verify updater operations are defined through narrow ipcRenderer.invoke
  assert.match(preloadSource, /updater:\s*Object\.freeze\(/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:status'\)/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:check'/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:download'\)/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:apply'/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('updater:rollback'\)/);

  // Verify absence of dangerous Node or Electron leakage
  assert.doesNotMatch(preloadSource, /ipcRenderer\.sendSync/);
  assert.doesNotMatch(preloadSource, /require\('child_process'\)/);
  assert.doesNotMatch(preloadSource, /require\('fs'\)/);
  assert.doesNotMatch(preloadSource, /remote/);
});

test('rollback IPC propagates quitRequested and schedules desktop shutdown after handoff', async () => {
  const mainSource = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(
    mainSource,
    /ipcMain\.handle\('updater:rollback',[\s\S]+const result = await desktopUpdater\?\.rollbackUpdate\(\);[\s\S]+if \(result\?\.quitRequested && result\.mechanism === 'staged-ready'\)[\s\S]+setTimeout\(\(\) => quitApplication\(\), 500\)/,
  );
});
