import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Alert, Button, Divider, Input, InputNumber, Modal, Radio, Select, Space, Spin, Switch, Tag, Typography } from 'antd';
import { ErrorDisplay } from './ErrorDisplay';
import { ReloadOutlined, SearchOutlined, SettingOutlined, UndoOutlined } from '@ant-design/icons';
import type { StoredAppProfile } from '../db/db';
import type { GenerationProvider, HardwareProfileId, InterfaceMode } from '../types';
import { updateAppProfile } from '../utils/appProfile';
import { setGenerationBatchSize, setGenerationConcurrency } from '../utils/generationSettings';
import { getProviderSettings, PROVIDERS, setProviderSettings } from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';
import { getModalApi } from '../utils/modalProvider';
import { serviceJson, serviceRequest } from '../utils/serviceApi';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  SHORTCUT_ACTIONS,
  changeKeyboardShortcut,
  formatKeyboardShortcut,
  shortcutFromKeyboardEvent,
  type KeyboardShortcuts,
  type ShortcutActionId,
} from '../utils/keyboardShortcuts';
import UpdaterStatusView from './UpdaterStatus';
import PromptStudio from './PromptStudio';
import AccentColorSetting from './AccentColorSetting';
import { ACCENT_COLORS } from '../utils/accentColor';

type SettingValue = string | number | boolean;
type SettingsValues = Record<string, SettingValue>;

interface SettingDefinition {
  key: string;
  type: 'string' | 'integer' | 'boolean';
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default: SettingValue;
  title: string;
  description: string;
  visibility: 'basic' | 'advanced';
  resourceEffect: 'none' | 'low' | 'medium' | 'high';
  restartRequired: boolean;
  reindexRequired: boolean;
  environment: string;
}

interface SettingsContract {
  registry: SettingDefinition[];
  profiles: Record<HardwareProfileId, SettingsValues>;
}

interface ResolvedSettings {
  profile: HardwareProfileId;
  values: SettingsValues;
  sources: Record<string, string>;
}

interface Props {
  profile: StoredAppProfile;
  dark: boolean;
  onThemeChange: (dark: boolean) => void;
  keyboardShortcuts: KeyboardShortcuts;
  onKeyboardShortcutChange: (actionId: ShortcutActionId, shortcut: string) => void;
  initialTab?: SettingsTab;
  onClose: () => void;
}

export type SettingsTab = 'overall' | 'shortcuts' | 'generation' | 'retrieval' | 'documents' | 'prompts' | 'updates' | 'advanced';

const settingsTabs: { key: SettingsTab; label: string; description: string }[] = [
  { key: 'overall', label: 'Overall', description: 'Appearance, interface mode, and hardware profile.' },
  { key: 'updates', label: 'Software Updates', description: 'Check for and install Quizzer software updates.' },
  { key: 'shortcuts', label: 'Shortcuts', description: 'Open the command palette or assign safe keyboard shortcuts to its actions.' },
  { key: 'generation', label: 'Generation', description: 'Question generation defaults and provider resource limits.' },
  { key: 'retrieval', label: 'Retrieval', description: 'Search planning, context, reranking, and embeddings.' },
  { key: 'documents', label: 'Documents', description: 'Document extraction and OCR behavior.' },
  { key: 'prompts', label: 'Prompt Studio', description: 'Edit, validate, preview, import, and export prompt profiles.' },
  { key: 'advanced', label: 'Advanced', description: 'Background work and plugin development settings.' },
];

const overallExtraSearchTerms = ['theme', 'appearance', 'light', 'dark'];
const accentSearchTerms = ['accent color', 'appearance', 'buttons', 'links', 'highlights', ...ACCENT_COLORS.map(color => color.label.toLowerCase())];
const updatesExtraSearchTerms = ['software update', 'update', 'version', 'stable', 'beta'];
const tabForDefinition = (definition: SettingDefinition): SettingsTab => {
  const section = definition.key.split('.')[0];
  if (section === 'interface' || section === 'hardware') return 'overall';
  if (section === 'generation') return 'generation';
  if (section === 'retrieval' || section === 'embeddings') return 'retrieval';
  if (section === 'extraction') return 'documents';
  return 'advanced';
};

const sectionLabels: Record<string, string> = {
  interface: 'Interface',
  hardware: 'Hardware profile',
  generation: 'Generation',
  retrieval: 'Retrieval',
  extraction: 'Document extraction',
  embeddings: 'Embeddings',
  jobs: 'Background work',
  plugins: 'Plugin development',
  providers: 'Provider limits',
};

const sourceLabel = (source: string) => source.startsWith('profile:')
  ? `${source.slice('profile:'.length).toUpperCase()} profile`
  : source === 'app-profile' ? 'App profile' : `${source[0]?.toUpperCase() ?? ''}${source.slice(1)}`;

interface SettingsSearchResult {
  key: string;
  label: string;
  description: string;
  tab: SettingsTab;
  targetId: string;
}

const settingTargetId = (key: string) => `setting-${key.replace(/[^a-z0-9-]/gi, '-')}`;
const searchMatches = (query: string, values: string[]) => values.some(value => value.toLowerCase().includes(query));

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return text;
  const parts: Array<{ text: string; match: boolean }> = [];
  let start = 0;
  while (start < text.length) {
    const matchAt = text.toLowerCase().indexOf(normalized, start);
    if (matchAt < 0) {
      parts.push({ text: text.slice(start), match: false });
      break;
    }
    if (matchAt > start) parts.push({ text: text.slice(start, matchAt), match: false });
    parts.push({ text: text.slice(matchAt, matchAt + normalized.length), match: true });
    start = matchAt + normalized.length;
  }
  return <>{parts.map((part, index) => part.match
    ? <mark key={`${index}-${part.text}`}>{part.text}</mark>
    : <span key={`${index}-${part.text}`}>{part.text}</span>)}</>;
}

export default function SettingsModal({
  profile,
  dark,
  onThemeChange,
  keyboardShortcuts,
  onKeyboardShortcutChange,
  initialTab,
  onClose,
}: Props) {
  const [contract, setContract] = useState<SettingsContract>();
  const [resolved, setResolved] = useState<ResolvedSettings>();
  const [draft, setDraft] = useState<SettingsValues>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(() => new Set());
  const [unsetKeys, setUnsetKeys] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'overall');
  const [focusTarget, setFocusTarget] = useState('');
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutActionId>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const message = getMessageApi();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextContract, nextResolved] = await Promise.all([
        serviceRequest<SettingsContract>('/api/v1/settings/schema'),
        serviceRequest<ResolvedSettings>(`/api/v1/settings?profile=${profile.hardwareProfile}`),
      ]);
      const values = {
        ...nextResolved.values,
        'interface.mode': profile.interfaceMode,
        'hardware.profile': profile.hardwareProfile,
      };
      setContract(nextContract);
      setResolved({
        ...nextResolved,
        profile: profile.hardwareProfile,
        values,
        sources: {
          ...nextResolved.sources,
          'interface.mode': 'app-profile',
          'hardware.profile': 'app-profile',
        },
      });
      setDraft(values);
      setDirtyKeys(new Set());
      setUnsetKeys(new Set());
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load settings');
    } finally {
      setLoading(false);
    }
  }, [profile.hardwareProfile, profile.interfaceMode]);

  useEffect(() => { void load(); }, [load]);

  const setValue = (key: string, value: SettingValue) => {
    const apply = () => {
      setDraft(current => ({ ...current, [key]: value }));
      setDirtyKeys(current => new Set(current).add(key));
      setUnsetKeys(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    };
    if (key === 'plugins.developerMode' && value === true && draft[key] !== true) {
      getModalApi().confirm({
        title: 'Enable Advanced Developer Mode?',
        content: 'Unsigned plugins can execute local code with their declared permissions. Only install plugins whose source and hashes you have verified.',
        okText: 'Enable developer mode',
        okButtonProps: { danger: true },
        onOk: apply,
      });
      return;
    }
    apply();
  };

  const resetSetting = (definition: SettingDefinition) => {
    const selectedProfile = draft['hardware.profile'] as HardwareProfileId;
    const fallback = definition.key === 'hardware.profile'
      ? definition.default
      : contract?.profiles[selectedProfile]?.[definition.key] ?? definition.default;
    setDraft(current => ({ ...current, [definition.key]: fallback }));
    setDirtyKeys(current => {
      const next = new Set(current);
      next.delete(definition.key);
      return next;
    });
    setUnsetKeys(current => new Set(current).add(definition.key));
  };

  const resetToProfile = () => {
    if (!contract) return;
    const selectedProfile = draft['hardware.profile'] as HardwareProfileId;
    const nextValues = Object.fromEntries(contract.registry.map(definition => [
      definition.key,
      contract.profiles[selectedProfile]?.[definition.key] ?? definition.default,
    ])) as SettingsValues;
    nextValues['hardware.profile'] = selectedProfile;
    nextValues['interface.mode'] = draft['interface.mode'];
    setDraft(nextValues);
    setDirtyKeys(new Set(['hardware.profile', 'interface.mode']));
    setUnsetKeys(new Set(contract.registry.map(definition => definition.key)
      .filter(key => key !== 'hardware.profile' && key !== 'interface.mode')));
  };

  const resetToDefaults = () => {
    if (!contract) return;
    setDraft(Object.fromEntries(contract.registry.map(definition => [definition.key, definition.default])));
    setDirtyKeys(new Set(contract.registry.map(definition => definition.key)));
    setUnsetKeys(new Set());
  };

  const save = async () => {
    if (!contract || (!dirtyKeys.size && !unsetKeys.size)) { onClose(); return; }
    setSaving(true);
    try {
      const values = Object.fromEntries([...dirtyKeys]
        .filter(key => !unsetKeys.has(key))
        .map(key => [key, draft[key]]));
      for (const profileKey of ['interface.mode', 'hardware.profile']) {
        if (!unsetKeys.has(profileKey)) values[profileKey] = draft[profileKey];
      }
      const next = await serviceJson<ResolvedSettings>('/api/v1/settings', 'PATCH', {
        values,
        unset: [...unsetKeys],
      });
      const interfaceMode = draft['interface.mode'] as InterfaceMode;
      const hardwareProfile = draft['hardware.profile'] as HardwareProfileId;
      if ((interfaceMode && interfaceMode !== profile.interfaceMode) || (hardwareProfile && hardwareProfile !== profile.hardwareProfile)) {
        await updateAppProfile({ interfaceMode, hardwareProfile });
      }
      setGenerationConcurrency(Number(next.values['generation.concurrency']));
      setGenerationBatchSize(Number(next.values['generation.batchSize']));
      const defaultProvider = next.values['generation.defaultProvider'];
      if (typeof defaultProvider === 'string' && PROVIDERS.some(provider => provider.id === defaultProvider)) {
        const current = getProviderSettings();
        setProviderSettings({ ...current, defaultProvider: defaultProvider as GenerationProvider });
      }
      window.dispatchEvent(new Event('quizzer:settings-changed'));
      message.success('Settings saved');
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  const advanced = (draft['interface.mode'] ?? profile.interfaceMode) === 'advanced';
  const visibleDefinitions = useMemo(() => (contract?.registry ?? [])
    .filter(definition => !definition.key.startsWith('providers.') && (advanced || definition.visibility === 'basic')), [advanced, contract]);
  const normalizedQuery = query.trim().toLowerCase();
  const definitions = useMemo(() => {
    return visibleDefinitions.filter(definition => !normalizedQuery || searchMatches(normalizedQuery,
      [definition.title, definition.description, definition.key, definition.environment]));
  }, [normalizedQuery, visibleDefinitions]);

  const searchResults = useMemo<SettingsSearchResult[]>(() => {
    if (!normalizedQuery) return [];
    const results: SettingsSearchResult[] = [];
    const addDefinitions = (tab: SettingsTab) => visibleDefinitions
      .filter(definition => tabForDefinition(definition) === tab && searchMatches(normalizedQuery,
        [definition.title, definition.description, definition.key, definition.environment]))
      .forEach(definition => results.push({
        key: definition.key,
        label: definition.title,
        description: `${settingsTabs.find(item => item.key === tab)?.label} · ${[definition.description, definition.key, definition.environment]
          .find(value => value.toLowerCase().includes(normalizedQuery)) ?? definition.description}`,
        tab,
        targetId: settingTargetId(definition.key),
      }));
    for (const tab of settingsTabs.filter(item => advanced || item.key !== 'prompts')) {
      if (tab.key === 'overall' && searchMatches(normalizedQuery, ['Theme', 'Choose the application color theme', ...overallExtraSearchTerms])) {
        results.push({ key: 'theme', label: 'Theme', description: 'Overall appearance · Choose the application color theme.', tab: 'overall', targetId: 'setting-theme' });
      }
      if (tab.key === 'overall' && searchMatches(normalizedQuery, accentSearchTerms)) {
        results.push({ key: 'accent-color', label: 'Accent color', description: 'Overall appearance - Color of buttons, links, and highlights.', tab: 'overall', targetId: 'setting-accent-color' });
      }
      if (tab.key === 'updates' && searchMatches(normalizedQuery, [tab.label, tab.description, ...updatesExtraSearchTerms])) {
        results.push({ key: 'updates', label: tab.label, description: 'Check for stable or beta software update versions.', tab: 'updates', targetId: 'setting-updates' });
      }
      if (tab.key === 'shortcuts') for (const action of SHORTCUT_ACTIONS) {
        if (searchMatches(normalizedQuery, [action.label, action.description, 'keyboard', 'shortcut', 'command palette'])) results.push({
          key: `shortcut-${action.id}`, label: action.label, description: `Shortcuts · Keyboard shortcut for a command palette action. ${action.description}`,
          tab: 'shortcuts', targetId: settingTargetId(`shortcut-${action.id}`),
        });
      }
      if (tab.key === 'prompts' && searchMatches(normalizedQuery, [tab.label, tab.description])) {
        results.push({ key: 'prompts', label: tab.label, description: tab.description, tab: 'prompts', targetId: 'settings-panel' });
      }
      addDefinitions(tab.key);
    }
    return results;
  }, [advanced, normalizedQuery, visibleDefinitions]);

  useEffect(() => {
    if (!focusTarget) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(focusTarget);
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
      setFocusTarget('');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, focusTarget]);

  const pendingDefinitions = (contract?.registry ?? []).filter(definition => dirtyKeys.has(definition.key) || unsetKeys.has(definition.key));
  const needsReindex = pendingDefinitions.some(definition => definition.reindexRequired);
  const needsRestart = pendingDefinitions.some(definition => definition.restartRequired);

  const control = (definition: SettingDefinition) => {
    const value = draft[definition.key];
    if (definition.key === 'interface.mode') return (
      <div role="radiogroup" aria-label={definition.title}>
        <Radio.Group optionType="button" buttonStyle="solid" value={String(value)}
          options={(definition.enum ?? ['simple', 'advanced']).map(option => ({ value: option, label: option[0].toUpperCase() + option.slice(1) }))}
          onChange={event => setValue(definition.key, event.target.value)} />
      </div>
    );
    if (definition.key === 'generation.defaultProvider') return (
      <Select aria-label={definition.title} value={String(value)} onChange={next => setValue(definition.key, next)}
        options={PROVIDERS.map(provider => ({ value: provider.id, label: provider.label }))} />
    );
    if (definition.enum) return (
      <Select aria-label={definition.title} value={String(value)} onChange={next => setValue(definition.key, next)}
        options={definition.enum.map(option => ({ value: option, label: option[0].toUpperCase() + option.slice(1) }))} />
    );
    if (definition.type === 'boolean') return (
      <Switch aria-label={definition.title} checked={Boolean(value)} checkedChildren="On" unCheckedChildren="Off"
        onChange={next => setValue(definition.key, next)} />
    );
    if (definition.type === 'integer') return (
      <InputNumber aria-label={definition.title} value={Number(value)} min={definition.minimum} max={definition.maximum}
        onChange={next => { if (next !== null) setValue(definition.key, next); }} />
    );
    return <Input aria-label={definition.title} value={String(value ?? '')} onChange={event => setValue(definition.key, event.target.value)} />;
  };

  const definitionRows = (tab: SettingsTab, suppressEmpty = false) => {
    const tabDefinitions = definitions.filter(definition => tabForDefinition(definition) === tab);
    const sections = [...new Set(tabDefinitions.map(definition => definition.key.split('.')[0]))];
    const showSectionTitles = sections.length > 1;
    if (!tabDefinitions.length && suppressEmpty) return null;
    if (!tabDefinitions.length) return (
      <Typography.Text type="secondary">
        {query.trim()
          ? `No ${settingsTabs.find(item => item.key === tab)?.label.toLowerCase()} settings match this search.`
          : `No settings are available in this category in ${advanced ? 'Advanced' : 'Simple'} mode.`}
      </Typography.Text>
    );
    return sections.map(section => (
      <section className="settings-section" key={section} aria-label={sectionLabels[section] ?? section}>
        {showSectionTitles && <Divider orientation="left" plain>{sectionLabels[section] ?? section}</Divider>}
        <div className="settings-list">
          {tabDefinitions.filter(definition => definition.key.startsWith(`${section}.`)).map(definition => {
            const changed = dirtyKeys.has(definition.key) || unsetKeys.has(definition.key);
            const selectedProfile = draft['hardware.profile'] as HardwareProfileId;
            const resetSource = definition.key !== 'hardware.profile' && contract?.profiles[selectedProfile]?.[definition.key] !== undefined
              ? `profile:${selectedProfile}`
              : 'default';
            return <div className={`settings-row${changed ? ' is-changed' : ''}`} id={settingTargetId(definition.key)} tabIndex={-1} key={definition.key}>
              <div className="settings-copy">
                <Typography.Text strong>{definition.title}</Typography.Text>
                <Typography.Text type="secondary">{definition.description}</Typography.Text>
                <Space size={[4, 4]} wrap>
                  <Tag>{sourceLabel(unsetKeys.has(definition.key) ? resetSource : resolved?.sources[definition.key] ?? 'default')}</Tag>
                  {definition.resourceEffect !== 'none' && <Tag>{definition.resourceEffect} resource impact</Tag>}
                  {definition.reindexRequired && <Tag>Reindex required</Tag>}
                  {definition.restartRequired && <Tag>Restart required</Tag>}
                  {advanced && <Typography.Text code>{definition.key}</Typography.Text>}
                </Space>
              </div>
              <div className="settings-control">
                {control(definition)}
                <Button type="text" size="small" icon={<UndoOutlined />} disabled={!changed && resolved?.sources[definition.key] !== 'user'}
                  aria-label={`Reset ${definition.title}`} onClick={() => resetSetting(definition)}>Reset</Button>
              </div>
            </div>;
          })}
        </div>
      </section>
    ));
  };

  const overallSearch = query.trim().toLowerCase();
  const showTheme = !overallSearch || overallExtraSearchTerms.some(term => term.includes(overallSearch) || overallSearch.includes(term));
  const showAccent = !overallSearch || searchMatches(overallSearch, accentSearchTerms);
  const showUpdates = !overallSearch || updatesExtraSearchTerms.some(term => term.includes(overallSearch) || overallSearch.includes(term));
  const hasOverallDefinitions = definitions.some(definition => tabForDefinition(definition) === 'overall');

  const overall = <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    {(showTheme || showAccent) && <section className="settings-section" aria-labelledby="settings-appearance">
      <Divider orientation="left" plain><span id="settings-appearance">Appearance</span></Divider>
      <div className="settings-list">
        {showTheme && <div className="settings-row" id="setting-theme" tabIndex={-1}>
          <div className="settings-copy">
            <Typography.Text strong>Theme</Typography.Text>
            <Typography.Text type="secondary">Choose the application color theme. This preference is applied immediately.</Typography.Text>
            <Space size={[4, 4]} wrap><Tag>App preference</Tag></Space>
          </div>
          <div className="settings-control settings-control-single">
            <div role="radiogroup" aria-label="Theme">
              <Radio.Group optionType="button" buttonStyle="solid" value={dark ? 'dark' : 'light'}
                options={[{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]}
                onChange={event => onThemeChange(event.target.value === 'dark')} />
            </div>
          </div>
        </div>}
        {showAccent && <AccentColorSetting />}
      </div>
    </section>}
    {definitionRows('overall', showTheme || showAccent)}
    {!showTheme && !showAccent && !hasOverallDefinitions && <Typography.Text type="secondary">No overall settings match this search.</Typography.Text>}
  </Space>;

  const updatesSettings = <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    {showUpdates && <section className="settings-section" id="setting-updates" tabIndex={-1} aria-label="Software updates">
      <UpdaterStatusView />
    </section>}
    {!showUpdates && <Typography.Text type="secondary">No software update settings match this search.</Typography.Text>}
  </Space>;

  const applyShortcut = (actionId: ShortcutActionId, shortcut: string) => {
    const changed = changeKeyboardShortcut(keyboardShortcuts, actionId, shortcut);
    if (!changed.ok) {
      message.error(changed.error);
      return;
    }
    onKeyboardShortcutChange(actionId, changed.shortcuts[actionId]);
    setRecordingShortcut(undefined);
  };

  const captureShortcut = (event: ReactKeyboardEvent<HTMLElement>, actionId: ShortcutActionId) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setRecordingShortcut(undefined);
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      applyShortcut(actionId, '');
      return;
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) {
      message.warning('Press Ctrl or Command with one supported key. Add Shift or Alt if needed.');
      return;
    }
    applyShortcut(actionId, shortcut);
  };

  const shortcutActions = SHORTCUT_ACTIONS.filter(action => !overallSearch
    || [action.label, action.description].some(value => value.toLowerCase().includes(overallSearch))
    || ['keyboard', 'shortcut'].some(value => value.includes(overallSearch) || overallSearch.includes(value)));

  const shortcutSettings = <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    {shortcutActions.length ? <section className="settings-section" aria-label="Command palette actions">
      <div className="settings-list">
        {shortcutActions.map(action => {
          const shortcut = keyboardShortcuts[action.id];
          const recording = recordingShortcut === action.id;
          return <div className="settings-row" id={settingTargetId(`shortcut-${action.id}`)} tabIndex={-1} key={action.id}>
            <div className="settings-copy">
              <Typography.Text strong>{action.label}</Typography.Text>
              <Typography.Text type="secondary">{action.description}</Typography.Text>
              <Space size={[4, 4]} wrap>
                <Tag color={shortcut ? 'blue' : undefined}>{shortcut ? formatKeyboardShortcut(shortcut) : 'Not assigned'}</Tag>
              </Space>
            </div>
            <Space className="settings-shortcut-actions" wrap>
              <Button type={recording ? 'primary' : 'default'} aria-label={`Record shortcut for ${action.label}`}
                onClick={() => setRecordingShortcut(action.id)} onBlur={() => setRecordingShortcut(current => current === action.id ? undefined : current)}
                onKeyDown={recording ? event => captureShortcut(event, action.id) : undefined}>
                {recording ? 'Press shortcut…' : 'Record'}
              </Button>
              <Button aria-label={`Clear shortcut for ${action.label}`} disabled={!shortcut} onClick={() => applyShortcut(action.id, '')}>Clear</Button>
              <Button aria-label={`Reset shortcut for ${action.label}`} disabled={shortcut === DEFAULT_KEYBOARD_SHORTCUTS[action.id]}
                onClick={() => applyShortcut(action.id, DEFAULT_KEYBOARD_SHORTCUTS[action.id])}>Reset</Button>
            </Space>
          </div>;
        })}
      </div>
    </section> : <Typography.Text type="secondary">No shortcut actions match this search.</Typography.Text>}
  </Space>;

  const tabItems = settingsTabs.filter(tab => advanced || tab.key !== 'prompts').map(tab => ({
    key: tab.key,
    label: tab.label,
    children: tab.key === 'prompts' ? <PromptStudio />
      : tab.key === 'overall' ? overall : tab.key === 'shortcuts' ? shortcutSettings : tab.key === 'updates' ? updatesSettings : definitionRows(tab.key),
  }));

  const moveTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % tabItems.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + tabItems.length) % tabItems.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabItems.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    setActiveTab(tabItems[nextIndex].key as SettingsTab);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };

  const footer = activeTab === 'prompts'
    ? <Button onClick={onClose}>Close</Button>
    : [
      <Button key="cancel" onClick={onClose}>Cancel</Button>,
      <Button key="profile" icon={<UndoOutlined />} disabled={!contract} onClick={resetToProfile}>Reset to selected profile</Button>,
      <Button key="defaults" disabled={!contract} onClick={resetToDefaults}>Built-in defaults</Button>,
      <Button key="save" type="primary" loading={saving} disabled={!dirtyKeys.size && !unsetKeys.size} onClick={() => void save()}>Save changes</Button>,
    ];

  return (
    <Modal open title={<Space><SettingOutlined /> Settings</Space>} width={activeTab === 'prompts' ? 1120 : 880} onCancel={onClose} footer={footer}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {error && <div><ErrorDisplay error={error} context="settings" /><Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>Retry settings</Button></div>}
        {(needsReindex || needsRestart) && <Alert type="warning" showIcon message="These changes have follow-up work" description={[
          needsReindex && 'Affected documents must be reindexed.',
          needsRestart && 'Quizzer must be restarted.',
        ].filter(Boolean).join(' ')} />}
        {loading ? <div className="settings-loading"><Spin /></div> : !error && (
          <div className="settings-layout">
            <div className="settings-sidebar">
              <Input allowClear prefix={<SearchOutlined />} value={query} onChange={event => setQuery(event.target.value)}
                aria-label="Search settings" placeholder="Search" />
              {normalizedQuery ? <div className="settings-search-results" aria-label="Settings search results">
                {searchResults.length ? searchResults.map(result => (
                  <button key={result.key} type="button" className="settings-search-result" onClick={() => {
                    setActiveTab(result.tab);
                    setFocusTarget(result.targetId);
                  }}>
                    <strong><HighlightMatch text={result.label} query={normalizedQuery} /></strong>
                    <span><HighlightMatch text={result.description} query={normalizedQuery} /></span>
                  </button>
                )) : <Typography.Text className="settings-search-empty" type="secondary">No settings found</Typography.Text>}
              </div> : <div className="settings-tab-list" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
                {tabItems.map((tab, index) => (
                  <button key={tab.key} type="button" role="tab" id={`settings-tab-${tab.key}`}
                    aria-controls="settings-panel" aria-selected={activeTab === tab.key} tabIndex={activeTab === tab.key ? 0 : -1}
                    onClick={() => setActiveTab(tab.key as SettingsTab)}
                    onKeyDown={event => moveTabFocus(event, index)}
                    className="settings-sidebar-item">
                    {tab.label}
                  </button>
                ))}
              </div>}
            </div>
            <div className="settings-content-pane" role="tabpanel" id="settings-panel"
              aria-label={tabItems.find(tab => tab.key === activeTab)?.label} tabIndex={0}>
              {tabItems.find(t => t.key === activeTab)?.children}
            </div>
          </div>
        )}
      </Space>
    </Modal>
  );
}
