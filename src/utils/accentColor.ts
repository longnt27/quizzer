export const ACCENT_COLOR_STORAGE_KEY = 'quizzer.accent-color';
export const ACCENT_COLOR_CHANGED_EVENT = 'quizzer:accent-color-changed';

// Paired palettes keep primary text and filled controls readable in both themes.
// Blue preserves the existing primary and selection colors.
export const ACCENT_COLORS = [
  { id: 'blue', label: 'Blue', light: { primary: '#0050b3', selected: '#e6f4ff' }, dark: { primary: '#69b1ff', selected: '#15395b' } },
  { id: 'purple', label: 'Purple', light: { primary: '#531dab', selected: '#f9f0ff' }, dark: { primary: '#b37feb', selected: '#302044' } },
  { id: 'green', label: 'Green', light: { primary: '#237804', selected: '#f6ffed' }, dark: { primary: '#95de64', selected: '#20351c' } },
  { id: 'teal', label: 'Teal', light: { primary: '#006d75', selected: '#e6fffb' }, dark: { primary: '#5cdbd3', selected: '#153638' } },
  { id: 'orange', label: 'Orange', light: { primary: '#ad4e00', selected: '#fff7e6' }, dark: { primary: '#ffc069', selected: '#3e2b19' } },
  { id: 'magenta', label: 'Magenta', light: { primary: '#9e1068', selected: '#fff0f6' }, dark: { primary: '#ff85c0', selected: '#421f34' } },
] as const;

export type AccentColor = typeof ACCENT_COLORS[number]['id'];
export const DEFAULT_ACCENT_COLOR: AccentColor = 'blue';

export function normalizeAccentColor(value: unknown): AccentColor {
  return ACCENT_COLORS.find(color => color.id === value)?.id ?? DEFAULT_ACCENT_COLOR;
}

export function getAccentPalette(color: AccentColor, dark: boolean) {
  const option = ACCENT_COLORS.find(candidate => candidate.id === color) ?? ACCENT_COLORS[0];
  return { ...option[dark ? 'dark' : 'light'], onPrimary: dark ? '#101214' : '#ffffff' };
}

export function loadAccentColor(storage?: Pick<Storage, 'getItem'>): AccentColor {
  try {
    return normalizeAccentColor((storage ?? localStorage).getItem(ACCENT_COLOR_STORAGE_KEY));
  } catch {
    // A denied/unavailable browser store must not prevent the app from opening.
    return DEFAULT_ACCENT_COLOR;
  }
}

export function saveAccentColor(color: AccentColor, storage?: Pick<Storage, 'setItem'>): void {
  if (!ACCENT_COLORS.some(option => option.id === color)) throw new Error('Unknown accent color');
  // Let the caller report failure rather than claiming a preference was saved.
  (storage ?? localStorage).setItem(ACCENT_COLOR_STORAGE_KEY, color);
}
