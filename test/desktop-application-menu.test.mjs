import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('desktop startup removes the default Electron application menu', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const readyIndex = source.indexOf('app.whenReady().then');
  const menuIndex = source.indexOf('Menu.setApplicationMenu(null)', readyIndex);
  const windowIndex = source.indexOf('createWindow()', readyIndex);

  assert.notEqual(readyIndex, -1);
  assert.ok(menuIndex > readyIndex, 'application menu should be removed during ready startup');
  assert.ok(windowIndex > menuIndex, 'application menu should be removed before the window is created');
});
