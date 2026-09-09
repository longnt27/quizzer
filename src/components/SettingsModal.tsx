import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Alert, Button, Divider, Input, InputNumber, Modal, Radio, Select, Space, Spin, Switch, Tag, Typography } from 'antd';
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
  onOpenCommandPalette: () => void;
  initialTab?: SettingsTab;
  onClose: () => void;
}

export type SettingsTab = 'overall' | 'shortcuts' | 'generation' | 'retrieval' | 'documents' | 'prompts' | 'advanced';

const settingsTabs: { key: SettingsTab; label: string; description: string }[] = [
  { key: 'overall', label: 'Overall', description: 'Appearance, interface mode, updates, and hardware profile.' },
  { key: 'shortcuts', label: 'Shortcuts', description: 'Open the command palette or assign safe keyboard shortcuts to its actions.' },
  { key: 'generation', label: 'Generation', description: 'Question generation defaults and provider resource limits.' },
  { key: 'retrieval', label: 'Retrieval', description: 'Search planning, context, reranking, and embeddings.' },
  { key: 'documents', label: 'Documents', description: 'Document extraction and OCR behavior.' },
  { key: 'prompts', label: 'Prompt Studio', description: 'Edit, validate, preview, import, and export prompt profiles.' },
  { key: 'advanced', label: 'Advanced', description: 'Background work and plugin development settings.' },
];

const overallExtraSearchTerms = ['theme', 'appearance', 'light', 'dark', 'software update', 'update', 'version', 'stable', 'beta'];
const shortcutExtraSearchTerms = [
  'keyboard', 'shortcut', 'command palette',
  ...SHORTCUT_ACTIONS.flatMap(action => [action.label.toLowerCase(), action.description.toLowerCase()]),
];

const tabForDefinition = (definition: SettingDefinition): SettingsTab => {
  const section = definition.key.split('.')[0];
  if (section === 'interface' || section === 'hardware') return 'overall';
  if (section === 'generation' || section === 'providers') return 'generation';
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

const resourceColor: Record<SettingDefinition['resourceEffect'], string | undefined> = {
  none: undefined,
  low: '#237804',
  medium: '#7a4b00',
  high: '#a61d24',
};

export default function SettingsModal({
  profile,
  dark,
  onThemeChange,
  keyboardShortcuts,
  onKeyboardShortcutChange,
  onOpenCommandPalette,
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
    .filter(definition => advanced || definition.visibility === 'basic'), [advanced, contract]);
  const definitions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return visibleDefinitions.filter(definition => !normalized || [definition.title, definition.description, definition.key, definition.environment]
      .some(value => value.toLowerCase().includes(normalized)));
  }, [query, visibleDefinitions]);

  useEffect(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return;
    const matchingTab = settingsTabs.find(tab => definitions.some(definition => tabForDefinition(definition) === tab.key)
      || (tab.key === 'overall' && overallExtraSearchTerms.some(term => term.includes(normalized) || normalized.includes(term)))
      || (tab.key === 'shortcuts' && shortcutExtraSearchTerms.some(term => term.includes(normalized) || normalized.includes(term))));
    if (matchingTab) setActiveTab(matchingTab.key);
  }, [definitions, query]);

  const pendingDefinitions = (contract?.registry ?? []).filter(definition => dirtyKeys.has(definition.key) || unsetKeys.has(definition.key));
  const needsReindex = pendingDefinitions.some(definition => definition.reindexRequired);
  const needsRestart = pendingDefinitions.some(definition => definition.restartRequired);

  const control = (definition: SettingDefinition) => {
    const value = draft[definition.key];
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
    if (!tabDefinitions.length && suppressEmpty) return null;
    if (!tabDefinitions.length) return (
      <Typography.Text type="secondary">
        {query.trim()
          ? `No ${settingsTabs.find(item => item.key === tab)?.label.toLowerCase()} settings match this search.`
          : `No settings are available in this category in ${advanced ? 'Advanced' : 'Simple'} mode.`}
      </Typography.Text>
    );
    return sections.map(section => (
      <section className="settings-section" key={section} aria-labelledby={`settings-${section}`}>
        <Divider orientation="left" plain><span id={`settings-${section}`}>{sectionLabels[section] ?? section}</span></Divider>
        <div className="settings-list">
          {tabDefinitions.filter(definition => definition.key.startsWith(`${section}.`)).map(definition => {
            const changed = dirtyKeys.has(definition.key) || unsetKeys.has(definition.key);
            const selectedProfile = draft['hardware.profile'] as HardwareProfileId;
            const resetSource = definition.key !== 'hardware.profile' && contract?.profiles[selectedProfile]?.[definition.key] !== undefined
              ? `profile:${selectedProfile}`
              : 'default';
            return <div className={`settings-row${changed ? ' is-changed' : ''}`} key={definition.key}>
              <div className="settings-copy">
                <Typography.Text strong>{definition.title}</Typography.Text>
                <Typography.Text type="secondary">{definition.description}</Typography.Text>
                <Space size={[4, 4]} wrap>
                  <Tag>{sourceLabel(unsetKeys.has(definition.key) ? resetSource : resolved?.sources[definition.key] ?? 'default')}</Tag>
                  {definition.resourceEffect !== 'none' && <Tag color={resourceColor[definition.resourceEffect]}>{definition.resourceEffect} resource impact</Tag>}
                  {definition.reindexRequired && <Tag color="#8a3b00">Reindex required</Tag>}
                  {definition.restartRequired && <Tag color="#a8071a">Restart required</Tag>}
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
  const showTheme = !overallSearch || overallExtraSearchTerms.slice(0, 4).some(term => term.includes(overallSearch) || overallSearch.includes(term));
  const showUpdates = !overallSearch || overallExtraSearchTerms.slice(4).some(term => term.includes(overallSearch) || overallSearch.includes(term));
  const hasOverallDefinitions = definitions.some(definition => tabForDefinition(definition) === 'overall');

  const overall = <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    {showTheme && <section className="settings-section" aria-labelledby="settings-appearance">
      <Divider orientation="left" plain><span id="settings-appearance">Appearance</span></Divider>
      <div className="settings-list">
        <div className="settings-row">
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
        </div>
      </div>
    </section>}
    {definitionRows('overall', showTheme || showUpdates)}
    {showUpdates && <section className="settings-section" aria-labelledby="settings-updates">
      <Divider orientation="left" plain><span id="settings-updates">Software updates</span></Divider>
      <UpdaterStatusView />
    </section>}
    {!showTheme && !showUpdates && !hasOverallDefinitions && <Typography.Text type="secondary">No overall settings match this search.</Typography.Text>}
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
    <Alert type="info" showIcon message="Keyboard shortcuts use Ctrl on Windows/Linux and Command on macOS."
      description="Changes are saved immediately. Choose Record, then press a primary modifier and one key. Press Backspace to clear or Escape to cancel. Duplicate and operating-system-reserved shortcuts are rejected." />
    <Button onClick={onOpenCommandPalette}>Open command palette</Button>
    {shortcutActions.length ? <section className="settings-section" aria-labelledby="settings-keyboard-shortcuts">
      <Divider orientation="left" plain><span id="settings-keyboard-shortcuts">Command palette actions</span></Divider>
      <div className="settings-list">
        {shortcutActions.map(action => {
          const shortcut = keyboardShortcuts[action.id];
          const recording = recordingShortcut === action.id;
          return <div className="settings-row" key={action.id}>
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
    children: tab.key === 'prompts' ? <PromptStudio /> : <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>{tab.description}</Typography.Paragraph>
      {tab.key === 'overall' ? overall : tab.key === 'shortcuts' ? shortcutSettings : definitionRows(tab.key)}
    </Space>,
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
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Browse settings by category or search across every category. Values show their source and any resource or indexing impact before saving.
        </Typography.Paragraph>
        <Input allowClear prefix={<SearchOutlined />} value={query} onChange={event => setQuery(event.target.value)}
          aria-label="Search settings" placeholder="Search settings, descriptions, keys, or environment variables" />
        {error && <Alert type="error" showIcon message={error} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>Retry</Button>} />}
        {(needsReindex || needsRestart) && <Alert type="warning" showIcon message="These changes have follow-up work" description={[
          needsReindex && 'Affected documents must be reindexed.',
          needsRestart && 'Quizzer must be restarted.',
        ].filter(Boolean).join(' ')} />}
        {loading ? <div className="settings-loading"><Spin /></div> : !error && (
          <div className="settings-layout">
            <div className="settings-sidebar" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
              {tabItems.map((tab, index) => (
                <button key={tab.key} type="button" role="tab" id={`settings-tab-${tab.key}`}
                  aria-controls="settings-panel" aria-selected={activeTab === tab.key} tabIndex={activeTab === tab.key ? 0 : -1}
                  onClick={() => setActiveTab(tab.key as SettingsTab)}
                  onKeyDown={event => moveTabFocus(event, index)}
                  className="settings-sidebar-item">
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="settings-content-pane" role="tabpanel" id="settings-panel"
              aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
              {tabItems.find(t => t.key === activeTab)?.children}
            </div>
          </div>
        )}
      </Space>
    </Modal>
  );
}
