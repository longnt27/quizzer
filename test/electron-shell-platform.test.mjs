import assert from 'node:assert/strict';
import test from 'node:test';
import {
  electronExecutableFromPackage,
  playwrightCommandForPlatform,
  spawnOptionsForPlatform,
  terminationPlanForPlatform,
} from '../scripts/electron-shell-platform.mjs';

test('uses detached process groups on POSIX and hides Windows child windows', () => {
  assert.deepEqual(spawnOptionsForPlatform('darwin'), { detached: true, windowsHide: false });
  assert.deepEqual(spawnOptionsForPlatform('linux'), { detached: true, windowsHide: false });
  assert.deepEqual(spawnOptionsForPlatform('win32'), { detached: false, windowsHide: true });
});

test('terminates POSIX process groups with portable signals', () => {
  assert.deepEqual(terminationPlanForPlatform({ platform: 'darwin', pid: 1234 }), {
    signal: 'SIGTERM', processGroup: -1234,
  });
  assert.deepEqual(terminationPlanForPlatform({ platform: 'linux', pid: 1234, force: true }), {
    signal: 'SIGKILL', processGroup: -1234,
  });
});

test('uses Windows taskkill tree termination instead of POSIX signals', () => {
  assert.deepEqual(terminationPlanForPlatform({ platform: 'win32', pid: 1234, systemRoot: 'C:\\Windows' }), {
    command: 'C:\\Windows\\System32\\taskkill.exe',
    args: ['/PID', '1234', '/T'],
  });
  assert.deepEqual(terminationPlanForPlatform({ platform: 'win32', pid: 1234, force: true }), {
    command: 'taskkill.exe',
    args: ['/PID', '1234', '/T', '/F'],
  });
});

test('resolves a native Electron executable from the package instead of a command shim', () => {
  assert.equal(electronExecutableFromPackage(() => '/opt/quizzer/node_modules/electron/dist/electron'), '/opt/quizzer/node_modules/electron/dist/electron');
  assert.throws(() => electronExecutableFromPackage(() => 'C:\\quizzer\\node_modules\\.bin\\electron.cmd'), /native Electron executable/);
});

test('wraps only Linux Playwright smoke in xvfb when requested', () => {
  const linux = playwrightCommandForPlatform({
    platform: 'linux',
    nodeExecutable: '/usr/bin/node',
    projectDirectory: '/workspace/quizzer',
    useXvfb: true,
  });
  assert.equal(linux.command, 'xvfb-run');
  assert.deepEqual(linux.args.slice(0, 3), ['--auto-servernum', '--server-args=-screen 0 1280x720x24', '/usr/bin/node']);
  assert.equal(linux.args.at(-1), '--config=playwright.electron.config.ts');

  const windows = playwrightCommandForPlatform({
    platform: 'win32',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    projectDirectory: 'C:\\workspace\\quizzer',
    useXvfb: true,
  });
  assert.equal(windows.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(windows.args[0], 'node_modules/@playwright/test/cli.js');
});
