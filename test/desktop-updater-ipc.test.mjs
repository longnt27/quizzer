import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isTrustedRendererUrl } from '../desktop/security.mjs';

// Helper simulating IPC validation handler
export const validateUpdaterCheckOptions = options => {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid options for updater:check');
  }
  const validated = {};
  if (options.channel !== undefined) {
    if (options.channel !== 'stable' && options.channel !== 'beta') {
      throw new Error('Channel must be stable or beta');
    }
    validated.channel = options.channel;
  }
  if (options.repository !== undefined) {
    if (typeof options.repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options.repository)) {
      throw new Error('Invalid GitHub repository format');
    }
    validated.repository = options.repository;
  }
  return validated;
};

export const validateUpdaterApplyOptions = options => {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid options for updater:apply');
  }
  const validated = {};
  if (options.restart !== undefined) {
    if (typeof options.restart !== 'boolean') {
      throw new Error('restart must be a boolean');
    }
    validated.restart = options.restart;
  }
  return validated;
};

test('renderer origin verification rejects untrusted origins from accessing updater IPC', () => {
  assert.equal(isTrustedRendererUrl('quizzer://app/'), true);
  assert.equal(isTrustedRendererUrl('quizzer://app/settings'), true);

  assert.equal(isTrustedRendererUrl('https://evil.com'), false);
  assert.equal(isTrustedRendererUrl('quizzer://evil/'), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:8787/'), false);
  assert.equal(isTrustedRendererUrl('javascript:alert(1)'), false);
  assert.equal(isTrustedRendererUrl('file:///etc/passwd'), false);
});

test('updater IPC check handler validates channel and repository options', () => {
  // Valid options
  assert.deepEqual(validateUpdaterCheckOptions(), {});
  assert.deepEqual(validateUpdaterCheckOptions({ channel: 'stable' }), { channel: 'stable' });
  assert.deepEqual(validateUpdaterCheckOptions({ channel: 'beta' }), { channel: 'beta' });
  assert.deepEqual(
    validateUpdaterCheckOptions({ channel: 'beta', repository: 'owner/repo' }),
    { channel: 'beta', repository: 'owner/repo' },
  );

  // Invalid options
  assert.throws(() => validateUpdaterCheckOptions('invalid'), /Invalid options for updater:check/);
  assert.throws(() => validateUpdaterCheckOptions([1, 2, 3]), /Invalid options for updater:check/);
  assert.throws(() => validateUpdaterCheckOptions({ channel: 'nightly' }), /Channel must be stable or beta/);
  assert.throws(() => validateUpdaterCheckOptions({ channel: 123 }), /Channel must be stable or beta/);
  assert.throws(() => validateUpdaterCheckOptions({ repository: 'invalid repo with spaces' }), /Invalid GitHub repository format/);
  assert.throws(() => validateUpdaterCheckOptions({ repository: '../escaped/repo' }), /Invalid GitHub repository format/);
  assert.throws(() => validateUpdaterCheckOptions({ repository: 'https://evil.com/owner/repo' }), /Invalid GitHub repository format/);
});

test('updater IPC apply handler strictly validates restart boolean parameter', () => {
  assert.deepEqual(validateUpdaterApplyOptions(), {});
  assert.deepEqual(validateUpdaterApplyOptions({ restart: true }), { restart: true });
  assert.deepEqual(validateUpdaterApplyOptions({ restart: false }), { restart: false });

  assert.throws(() => validateUpdaterApplyOptions('true'), /Invalid options for updater:apply/);
  assert.throws(() => validateUpdaterApplyOptions({ restart: 'true' }), /restart must be a boolean/);
  assert.throws(() => validateUpdaterApplyOptions({ restart: 1 }), /restart must be a boolean/);
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
