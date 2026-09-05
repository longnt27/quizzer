import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Divider, Input, InputNumber, Modal, Select, Space, Spin, Switch, Tag, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined, SettingOutlined, UndoOutlined } from '@ant-design/icons';
import type { StoredAppProfile } from '../db/db';
import type { GenerationProvider, HardwareProfileId, InterfaceMode } from '../types';
import { setHardwareProfile, setInterfaceMode } from '../utils/appProfile';
import { setGenerationBatchSize, setGenerationConcurrency } from '../utils/generationSettings';
import { getProviderSettings, PROVIDERS, setProviderSettings } from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';
import { serviceJson, serviceRequest } from '../utils/serviceApi';

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
  onClose: () => void;
}

const sectionLabels: Record<string, string> = {
  interface: 'Interface',
  hardware: 'Hardware profile',
  generation: 'Generation',
  retrieval: 'Retrieval',
  extraction: 'Document extraction',
  embeddings: 'Embeddings',
  jobs: 'Background work',
  plugins: 'Plugin development',
};

const sourceLabel = (source: string) => source.startsWith('profile:')
  ? `${source.slice('profile:'.length).toUpperCase()} profile`
  : source === 'app-profile' ? 'App profile' : `${source[0]?.toUpperCase() ?? ''}${source.slice(1)}`;

const resourceColor: Record<SettingDefinition['resourceEffect'], string | undefined> = {
  none: undefined,
  low: 'green',
  medium: 'gold',
  high: 'volcano',
};

export default function SettingsModal({ profile, onClose }: Props) {
  const [contract, setContract] = useState<SettingsContract>();
  const [resolved, setResolved] = useState<ResolvedSettings>();
  const [draft, setDraft] = useState<SettingsValues>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(() => new Set());
  const [unsetKeys, setUnsetKeys] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
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
      Modal.confirm({
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
      if (interfaceMode && interfaceMode !== profile.interfaceMode) await setInterfaceMode(interfaceMode);
      if (hardwareProfile && hardwareProfile !== profile.hardwareProfile) await setHardwareProfile(hardwareProfile);
      setGenerationConcurrency(Number(next.values['generation.concurrency']));
      setGenerationBatchSize(Number(next.values['generation.batchSize']));
      const defaultProvider = next.values['generation.defaultProvider'];
      if (typeof defaultProvider === 'string' && PROVIDERS.some(provider => provider.id === defaultProvider)) {
        const current = getProviderSettings();
        setProviderSettings({ ...current, defaultProvider: defaultProvider as GenerationProvider });
      }
      message.success('Settings saved');
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  const advanced = (draft['interface.mode'] ?? profile.interfaceMode) === 'advanced';
  const definitions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (contract?.registry ?? []).filter(definition => (advanced || definition.visibility === 'basic')
      && (!normalized || [definition.title, definition.description, definition.key, definition.environment]
        .some(value => value.toLowerCase().includes(normalized))));
  }, [advanced, contract, query]);
  const sections = useMemo(() => [...new Set(definitions.map(definition => definition.key.split('.')[0]))], [definitions]);
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

  return (
    <Modal open title={<Space><SettingOutlined /> Settings</Space>} width={880} onCancel={onClose} footer={[
      <Button key="cancel" onClick={onClose}>Cancel</Button>,
      <Button key="profile" icon={<UndoOutlined />} disabled={!contract} onClick={resetToProfile}>Reset to selected profile</Button>,
      <Button key="defaults" disabled={!contract} onClick={resetToDefaults}>Built-in defaults</Button>,
      <Button key="save" type="primary" loading={saving} disabled={!dirtyKeys.size && !unsetKeys.size} onClick={() => void save()}>Save changes</Button>,
    ]}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Search every Quizzer setting, see where its value comes from, and understand resource or indexing impact before saving.
        </Typography.Paragraph>
        <Input allowClear prefix={<SearchOutlined />} value={query} onChange={event => setQuery(event.target.value)}
          aria-label="Search settings" placeholder="Search settings, descriptions, keys, or environment variables" />
        {error && <Alert type="error" showIcon message={error} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>Retry</Button>} />}
        {(needsReindex || needsRestart) && <Alert type="warning" showIcon message="These changes have follow-up work" description={[
          needsReindex && 'Affected documents must be reindexed.',
          needsRestart && 'Quizzer must be restarted.',
        ].filter(Boolean).join(' ')} />}
        {loading ? <div className="settings-loading"><Spin /></div> : definitions.length ? sections.map(section => (
          <section className="settings-section" key={section} aria-labelledby={`settings-${section}`}>
            <Divider orientation="left" plain><span id={`settings-${section}`}>{sectionLabels[section] ?? section}</span></Divider>
            <div className="settings-list">
              {definitions.filter(definition => definition.key.startsWith(`${section}.`)).map(definition => {
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
                      {definition.reindexRequired && <Tag color="orange">Reindex required</Tag>}
                      {definition.restartRequired && <Tag color="red">Restart required</Tag>}
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
        )) : !error && <Typography.Text type="secondary">No settings match this search in {advanced ? 'Advanced' : 'Simple'} mode.</Typography.Text>}
      </Space>
    </Modal>
  );
}
