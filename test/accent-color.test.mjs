import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCENT_COLORS,
  ACCENT_COLOR_STORAGE_KEY,
  DEFAULT_ACCENT_COLOR,
  getAccentPalette,
  loadAccentColor,
  normalizeAccentColor,
  saveAccentColor,
} from '../src/utils/accentColor.ts';

const luminance = hex => {
  const rgb = hex.slice(1).match(/../g).map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (first, second) => {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

test('recognizes every named accent and defaults invalid persisted values to blue', () => {
  assert.equal(new Set(ACCENT_COLORS.map(color => color.id)).size, ACCENT_COLORS.length);
  for (const color of ACCENT_COLORS) assert.equal(normalizeAccentColor(color.id), color.id);
  for (const value of [null, undefined, '', 'unknown', '#ff0000', 42, {}, '__proto__']) {
    assert.equal(normalizeAccentColor(value), DEFAULT_ACCENT_COLOR);
    assert.equal(loadAccentColor({ getItem: () => value }), DEFAULT_ACCENT_COLOR);
  }
});

test('round-trips each accent without overwriting other preferences', () => {
  const saved = new Map([['quizzer.theme', 'dark']]);
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  for (const color of ACCENT_COLORS) {
    saveAccentColor(color.id, storage);
    assert.equal(saved.get(ACCENT_COLOR_STORAGE_KEY), color.id);
    assert.equal(loadAccentColor(storage), color.id);
  }
  saveAccentColor(DEFAULT_ACCENT_COLOR, storage);
  assert.equal(loadAccentColor(storage), 'blue');
  assert.equal(saved.get('quizzer.theme'), 'dark');
});

test('survives blocked reads but reports failed writes and rejects invalid choices', () => {
  assert.equal(loadAccentColor({ getItem() { throw new Error('denied'); } }), 'blue');
  assert.throws(() => saveAccentColor('purple', { setItem() { throw new Error('quota'); } }), /quota/);
  assert.throws(() => saveAccentColor('invalid', { setItem() { assert.fail('must not write'); } }), /Unknown accent/);
});

test('preserves the original blue primary and selected backgrounds', () => {
  assert.deepEqual(getAccentPalette('blue', false), { primary: '#0050b3', selected: '#e6f4ff', onPrimary: '#ffffff' });
  assert.deepEqual(getAccentPalette('blue', true), { primary: '#69b1ff', selected: '#15395b', onPrimary: '#101214' });
});

test('all accent palettes have readable text, controls and selection backgrounds', () => {
  for (const color of ACCENT_COLORS) for (const dark of [false, true]) {
    const palette = getAccentPalette(color.id, dark);
    const surfaces = dark ? ['#101214', '#17191c', '#202328', '#1c1f23'] : ['#ffffff', '#f5f7fa', '#f0f2f5', '#f5f5f7'];
    for (const surface of surfaces) assert.ok(contrast(palette.primary, surface) >= 4.5, `${color.id} primary on ${surface}`);
    assert.ok(contrast(palette.primary, palette.onPrimary) >= 4.5, `${color.id} filled text`);
    assert.ok(contrast(dark ? '#e6e8eb' : '#1f2328', palette.selected) >= 4.5, `${color.id} selected text`);
    assert.ok(contrast(palette.primary, palette.selected) >= 4.5, `${color.id} selected accent text`);
  }
});
