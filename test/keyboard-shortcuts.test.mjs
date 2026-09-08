import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  changeKeyboardShortcut,
  formatKeyboardShortcut,
  keyboardShortcutMatches,
  normalizeKeyboardShortcut,
  normalizeKeyboardShortcuts,
  shortcutFromKeyboardEvent,
} from '../src/utils/keyboardShortcuts.ts';

const keyEvent = (overrides = {}) => ({
  key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...overrides,
});

test('normalizes only safe primary-modifier keyboard chords', () => {
  assert.equal(normalizeKeyboardShortcut('command + shift + k'), 'Mod+Shift+K');
  assert.equal(normalizeKeyboardShortcut('Ctrl+,'), 'Mod+Comma');
  assert.equal(normalizeKeyboardShortcut('K'), null);
  assert.equal(normalizeKeyboardShortcut('Mod'), null);
  assert.equal(normalizeKeyboardShortcut('Mod+Shift+K+P'), null);
  assert.equal(normalizeKeyboardShortcut('Mod+Escape'), null);
  assert.equal(normalizeKeyboardShortcut('Mod+Q'), null);
  assert.equal(normalizeKeyboardShortcut('Mod+Shift+Q'), 'Mod+Shift+Q');
});

test('captures and matches exact cross-platform shortcut modifiers', () => {
  assert.equal(shortcutFromKeyboardEvent(keyEvent({ shiftKey: true })), 'Mod+Shift+K');
  assert.equal(shortcutFromKeyboardEvent(keyEvent({ metaKey: false, ctrlKey: true, code: 'Comma', key: ',' })), 'Mod+Comma');
  assert.equal(shortcutFromKeyboardEvent(keyEvent({ metaKey: true, ctrlKey: true })), null);
  assert.equal(keyboardShortcutMatches(keyEvent(), 'Mod+K'), true);
  assert.equal(keyboardShortcutMatches(keyEvent({ shiftKey: true }), 'Mod+K'), false);
  assert.equal(keyboardShortcutMatches(keyEvent({ altKey: true }), 'Mod+Alt+K'), true);
});

test('sanitizes persisted settings and rejects shortcut conflicts', () => {
  const sanitized = normalizeKeyboardShortcuts({
    'command-palette': 'garbage',
    settings: 'Mod+K',
    home: 'Mod+Shift+H',
    theme: 42,
  });
  assert.equal(sanitized['command-palette'], DEFAULT_KEYBOARD_SHORTCUTS['command-palette']);
  assert.equal(sanitized.settings, '');
  assert.equal(sanitized.home, 'Mod+Shift+H');
  assert.equal(sanitized.theme, '');

  const conflict = changeKeyboardShortcut(sanitized, 'settings', 'Mod+Shift+H');
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /Go to Home/);
  const changed = changeKeyboardShortcut(sanitized, 'settings', 'Mod+Period');
  assert.equal(changed.ok, true);
  assert.equal(changed.shortcuts.settings, 'Mod+Period');
  const reserved = changeKeyboardShortcut(sanitized, 'settings', 'Mod+W');
  assert.equal(reserved.ok, false);
  assert.match(reserved.error, /reserved/);
});

test('formats shortcuts for native platform conventions', () => {
  assert.equal(formatKeyboardShortcut('Mod+Shift+Comma', true), '⌘ ⇧ ,');
  assert.equal(formatKeyboardShortcut('Mod+Alt+K', false), 'Ctrl + Alt + K');
  assert.equal(formatKeyboardShortcut('', false), '');
});
