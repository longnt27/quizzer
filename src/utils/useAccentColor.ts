import { useSyncExternalStore } from 'react';
import {
  ACCENT_COLOR_CHANGED_EVENT,
  ACCENT_COLOR_STORAGE_KEY,
  DEFAULT_ACCENT_COLOR,
  loadAccentColor,
  saveAccentColor,
  type AccentColor,
} from './accentColor';

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACCENT_COLOR_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener(ACCENT_COLOR_CHANGED_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ACCENT_COLOR_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useAccentColor() {
  return useSyncExternalStore(subscribe, loadAccentColor, () => DEFAULT_ACCENT_COLOR);
}

export function changeAccentColor(color: AccentColor) {
  saveAccentColor(color);
  window.dispatchEvent(new Event(ACCENT_COLOR_CHANGED_EVENT));
}
