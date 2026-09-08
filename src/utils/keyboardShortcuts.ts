export const KEYBOARD_SHORTCUT_STORAGE_KEY = 'quizzer.keyboardShortcuts.v1';

export const SHORTCUT_ACTIONS = [
  { id: 'command-palette', label: 'Open command palette', description: 'Search and run every Quizzer command.' },
  { id: 'settings', label: 'Open Settings', description: 'Open application settings.' },
  { id: 'home', label: 'Go to Home', description: 'Return to the application home screen.' },
  { id: 'test-create', label: 'Create a test', description: 'Open test creation.' },
  { id: 'document-add', label: 'Add documents', description: 'Open document import.' },
  { id: 'activity', label: 'Open Activity', description: 'Review active and completed work.' },
  { id: 'plugins', label: 'Open plugins & models', description: 'Configure providers, tools, and plugins.' },
  { id: 'prompts', label: 'Open Prompt Studio', description: 'Open prompt profiles when Advanced mode is active.' },
  { id: 'mode', label: 'Switch interface mode', description: 'Toggle between Simple and Advanced mode.' },
  { id: 'tutorial', label: 'Restart tutorial', description: 'Restart the guided setup.' },
  { id: 'theme', label: 'Switch theme', description: 'Toggle between the light and dark themes.' },
] as const;

export type ShortcutActionId = typeof SHORTCUT_ACTIONS[number]['id'];
export type KeyboardShortcuts = Record<ShortcutActionId, string>;

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
  'command-palette': 'Mod+K',
  settings: 'Mod+Comma',
  home: '',
  'test-create': '',
  'document-add': '',
  activity: '',
  plugins: '',
  prompts: '',
  mode: '',
  tutorial: '',
  theme: '',
};

interface KeyboardEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const namedKeys = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Enter', 'Space', 'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'BracketLeft',
  'BracketRight', 'Backslash', 'Minus', 'Equal', 'Backquote',
]);

const reservedPrimaryShortcuts = new Set(['Mod+A', 'Mod+C', 'Mod+F', 'Mod+L', 'Mod+N', 'Mod+P', 'Mod+Q', 'Mod+R', 'Mod+S', 'Mod+T', 'Mod+V', 'Mod+W', 'Mod+X', 'Mod+Z']);

const keyAliases: Record<string, string> = {
  ' ': 'Space',
  spacebar: 'Space',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
};

const canonicalKey = (input: string) => {
  const trimmed = input.trim();
  const alias = keyAliases[trimmed.toLowerCase()] ?? keyAliases[trimmed];
  if (alias) return alias;
  if (/^[a-z0-9]$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  const named = [...namedKeys].find(key => key.toLowerCase() === trimmed.toLowerCase());
  return named ?? null;
};

const eventKey = (event: KeyboardEventLike) => {
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (namedKeys.has(code)) return code;
  return canonicalKey(event.key);
};

export const normalizeKeyboardShortcut = (input: string): string | null => {
  if (!input.trim()) return '';
  const parts = input.split('+').map(part => part.trim()).filter(Boolean);
  let mod = false;
  let shift = false;
  let alt = false;
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod' || lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'ctrl' || lower === 'control') {
      if (mod) return null;
      mod = true;
    } else if (lower === 'shift') {
      if (shift) return null;
      shift = true;
    } else if (lower === 'alt' || lower === 'option') {
      if (alt) return null;
      alt = true;
    } else {
      if (key) return null;
      key = canonicalKey(part);
      if (!key) return null;
    }
  }
  if (!mod || !key) return null;
  const normalized = ['Mod', shift && 'Shift', alt && 'Alt', key].filter(Boolean).join('+');
  return reservedPrimaryShortcuts.has(normalized) ? null : normalized;
};

export const shortcutFromKeyboardEvent = (event: KeyboardEventLike): string | null => {
  if ((!event.metaKey && !event.ctrlKey) || (event.metaKey && event.ctrlKey)) return null;
  const key = eventKey(event);
  if (!key) return null;
  return ['Mod', event.shiftKey && 'Shift', event.altKey && 'Alt', key].filter(Boolean).join('+');
};

export const keyboardShortcutMatches = (event: KeyboardEventLike, shortcut: string) => {
  const normalized = normalizeKeyboardShortcut(shortcut);
  if (!normalized || (event.metaKey && event.ctrlKey) || (!event.metaKey && !event.ctrlKey)) return false;
  const parts = new Set(normalized.split('+'));
  return parts.has('Shift') === event.shiftKey
    && parts.has('Alt') === event.altKey
    && parts.has(eventKey(event) ?? '');
};

const displayKeys: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

export const formatKeyboardShortcut = (shortcut: string, apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)) => {
  const normalized = normalizeKeyboardShortcut(shortcut);
  if (!normalized) return '';
  const parts = normalized.split('+');
  const key = displayKeys[parts.at(-1) ?? ''] ?? parts.at(-1);
  if (apple) return [parts.includes('Mod') && '⌘', parts.includes('Shift') && '⇧', parts.includes('Alt') && '⌥', key].filter(Boolean).join(' ');
  return [parts.includes('Mod') && 'Ctrl', parts.includes('Shift') && 'Shift', parts.includes('Alt') && 'Alt', key].filter(Boolean).join(' + ');
};

export const normalizeKeyboardShortcuts = (value: unknown): KeyboardShortcuts => {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const used = new Set<string>();
  return Object.fromEntries(SHORTCUT_ACTIONS.map(action => {
    const raw = Object.hasOwn(stored, action.id) ? stored[action.id] : DEFAULT_KEYBOARD_SHORTCUTS[action.id];
    const normalized = typeof raw === 'string' ? normalizeKeyboardShortcut(raw) : null;
    const fallback = normalizeKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS[action.id]) ?? '';
    const shortcut = normalized === null ? fallback : normalized;
    if (!shortcut || used.has(shortcut)) return [action.id, ''];
    used.add(shortcut);
    return [action.id, shortcut];
  })) as KeyboardShortcuts;
};

export const changeKeyboardShortcut = (current: KeyboardShortcuts, actionId: ShortcutActionId, shortcut: string) => {
  const normalized = normalizeKeyboardShortcut(shortcut);
  if (normalized === null) return { ok: false as const, error: 'Use Ctrl/Command with a supported key that is not reserved by the operating system or browser.' };
  const conflict = normalized && SHORTCUT_ACTIONS.find(action => action.id !== actionId && current[action.id] === normalized);
  if (conflict) return { ok: false as const, error: `That shortcut is already used by ${conflict.label}.` };
  return { ok: true as const, shortcuts: { ...current, [actionId]: normalized } };
};

export const loadKeyboardShortcuts = (): KeyboardShortcuts => {
  try {
    return normalizeKeyboardShortcuts(JSON.parse(localStorage.getItem(KEYBOARD_SHORTCUT_STORAGE_KEY) ?? '{}'));
  } catch {
    return normalizeKeyboardShortcuts({});
  }
};

export const saveKeyboardShortcuts = (shortcuts: KeyboardShortcuts) => {
  localStorage.setItem(KEYBOARD_SHORTCUT_STORAGE_KEY, JSON.stringify(normalizeKeyboardShortcuts(shortcuts)));
};
