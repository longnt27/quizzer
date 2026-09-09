import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Divider, Empty, Input, InputNumber, Modal, Space, Spin, Switch, Tabs, Tag, Typography } from 'antd';
import {
  ApiOutlined, CloudDownloadOutlined, DeleteOutlined, FileSearchOutlined, FolderOpenOutlined,
  LoginOutlined, ReloadOutlined, RobotOutlined, RollbackOutlined, ScanOutlined, SettingOutlined,
  ShareAltOutlined,
} from '@ant-design/icons';
import type { GenerationProvider, InterfaceMode } from '../types';
import {
  AGENT_PROVIDERS, API_PROVIDERS, PROVIDERS, forgetRememberedApiKey, getApiKey, getProviderSettings,
  isNumericLoopbackEndpoint, isOpenAILoopbackEndpoint, loadRememberedApiKeys, migrateLegacyGeminiKey,
  ollamaModelMatches, rememberApiKey, setApiKey, setProviderSettings, type AgentProvider,
} from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';
import { getModalApi } from '../utils/modalProvider';
import { executeTwoPhaseAction, serviceFetch, serviceJson, serviceRequest } from '../utils/serviceApi';

type JobState = 'idle' | 'working' | 'complete' | 'error';
type AgentStatus = { installed: boolean; connected: boolean; job?: { state: JobState; message: string } };
type ComponentSetter = (value: string) => void;

interface OllamaModel {
  name: string;
  model: string;
  size: number;
  modifiedAt?: string;
  details?: { family?: string; parameterSize?: string; quantization?: string };
}

interface IntegrationStatus {
  marker: { installed: boolean; managed: boolean; job: { state: JobState; message: string } };
  ocr: { installed: boolean; managed: boolean; job: { state: JobState; message: string } };
  codex: AgentStatus;
  'claude-agent': AgentStatus;
  'antigravity-agent': AgentStatus;
  ollama: { installed: boolean; serverReady: boolean; models: OllamaModel[]; job: { state: JobState; message: string } };
  'llama-cpp': {
    configured: boolean;
    serverReady: boolean;
    models: Array<{ id: string }>;
    capabilities: string[];
    error?: string;
    runtime?: {
      mode: 'manual' | 'managed';
      state: 'idle' | 'starting' | 'running' | 'stopping' | 'error';
      configured: boolean;
      serverReady: boolean;
      host: string;
      port: number;
      executableName?: string;
      modelName?: string;
      pid?: number;
      lastError?: string;
      output?: string;
    };
  };
  embeddings: { installed: boolean; runtimeInstalled: boolean; model: string; job: { state: JobState; message: string } };
}

interface ExternalPlugin {
  id: string;
  name?: string;
  version?: string;
  capabilities?: string[];
  resources?: { memoryMB: number; diskMB: number; accelerators?: string[] };
  permissions?: { network: string[]; filesystem: string[]; secrets: string[]; subprocess: boolean };
  enabled: boolean;
  trust?: 'signed' | 'unsigned-local';
  source?: 'local' | 'registry';
  registryId?: string;
  availableVersion?: string;
  updateAvailable?: boolean;
  compatible: boolean;
  status: 'installed' | 'blocked' | 'broken';
  warning?: string;
  error?: string;
  rollbackAvailable?: boolean;
}

interface RegistryPlugin {
  id: string;
  name: string;
  description?: string;
  version: string;
  capabilities: string[];
  platforms: { os: string; architectures: string[] }[];
  resources?: { memoryMB: number; diskMB: number; accelerators?: string[] };
  permissions: { network: string[]; filesystem: string[]; secrets: string[]; subprocess: boolean };
  manifestUrl: string;
  downloadBaseUrl?: string;
  downloadSize?: number;
  installed: boolean;
  installedVersion?: string | null;
  updateAvailable?: boolean;
  compatible: boolean;
}

interface PluginCollection { plugins: ExternalPlugin[]; }
interface HealthResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  declaredMemoryMB?: number;
  scopedFileBytes?: number;
  resourceSamples?: number;
  peakRssBytes?: number;
}

interface Props { interfaceMode: InterfaceMode; onClose: () => void; }

interface IntegrationOptionProps {
  icon: ReactNode;
  title: string;
  description: string;
  state: string;
  checked?: boolean;
  switchLabel?: string;
  switchDisabled?: boolean;
  onToggle?: (checked: boolean) => void;
  actions?: ReactNode;
  details?: ReactNode;
  warning?: boolean;
}

function IntegrationOption({
  icon, title, description, state, checked, switchLabel, switchDisabled, onToggle, actions, details, warning,
}: IntegrationOptionProps) {
  return (
    <section className={`plugin-option${warning ? ' plugin-option-warning' : ''}`}>
      <div className="plugin-option-main">
        <span className="plugin-option-icon" aria-hidden="true">{icon}</span>
        <div className="plugin-option-copy">
          <Typography.Text strong>{title}</Typography.Text>
          <Typography.Text type="secondary">{description}</Typography.Text>
          <Typography.Text className="plugin-option-state" type="secondary">{state}</Typography.Text>
        </div>
        <Space className="plugin-option-actions" size="small" wrap>
          {actions}
          {onToggle ? <Switch checked={checked} disabled={switchDisabled} onChange={onToggle} aria-label={switchLabel ?? `Enable ${title}`} /> : null}
        </Space>
      </div>
      {details ? <div className="plugin-option-details">{details}</div> : null}
    </section>
  );
}

const providerName = (label: string) => label.replace(' – ', ' ');

export default function PluginsModal({ interfaceMode, onClose }: Props) {
  const [initial] = useState(() => {
    migrateLegacyGeminiKey();
    return getProviderSettings();
  });
  const [defaultProvider, setDefaultProvider] = useState(initial.defaultProvider);
  const [models, setModels] = useState(initial.models);
  const [enabledProviders, setEnabledProviders] = useState(initial.enabledProviders);
  const [enabledTools, setEnabledTools] = useState(initial.enabledTools);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => Object.fromEntries(API_PROVIDERS.map(provider => [provider.id, getApiKey(provider.id)])));
  const [rememberedProviders, setRememberedProviders] = useState<Set<string>>(new Set());
  const [concurrencies, setConcurrencies] = useState<Record<string, number>>({});
  const [credentialStorage, setCredentialStorage] = useState<{ available: boolean; backend: string; message: string }>({
    available: false,
    backend: 'unavailable',
    message: window.quizzerDesktop ? 'Checking operating-system credential protection…' : 'Remembered credentials are available only in the desktop app.',
  });
  const [credentialReady, setCredentialReady] = useState(!window.quizzerDesktop);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [externalPlugins, setExternalPlugins] = useState<ExternalPlugin[]>([]);
  const [registryPlugins, setRegistryPlugins] = useState<RegistryPlugin[]>([]);
  const [extractorPlugin, setExtractorPlugin] = useState('builtin');
  const [ocrPlugin, setOcrPlugin] = useState('builtin');
  const [embedderPlugin, setEmbedderPlugin] = useState('builtin');
  const [vectorIndexPlugin, setVectorIndexPlugin] = useState('builtin');
  const [rerankerPlugin, setRerankerPlugin] = useState('builtin');
  const [openaiCompatibleEndpoint, setOpenaiCompatibleEndpoint] = useState('https://api.openai.com/v1');
  const [llamaCppEndpoint, setLlamaCppEndpoint] = useState('http://127.0.0.1:8080/v1');
  const [llamaCppExecutablePath, setLlamaCppExecutablePath] = useState('');
  const [llamaCppModelPath, setLlamaCppModelPath] = useState('');
  const [externalError, setExternalError] = useState('');
  const [externalLoading, setExternalLoading] = useState(true);
  const [developerMode, setDeveloperMode] = useState(false);
  const [pluginAction, setPluginAction] = useState('');
  const [saving, setSaving] = useState(false);
  const [healthResults, setHealthResults] = useState<Record<string, HealthResult>>({});
  const [modelSettingsTarget, setModelSettingsTarget] = useState<GenerationProvider | null>(null);
  const [managedPluginId, setManagedPluginId] = useState<string | null>(null);
  const message = getMessageApi();

  const readyGeneratorPlugins = useMemo(() => externalPlugins.filter(plugin => plugin.status === 'installed' && plugin.enabled
    && plugin.compatible && plugin.capabilities?.includes('generator')), [externalPlugins]);
  const installedByCapability = useMemo(() => {
    const result = new Map<string, ExternalPlugin[]>();
    for (const plugin of externalPlugins) for (const capability of plugin.capabilities ?? []) {
      result.set(capability, [...(result.get(capability) ?? []), plugin]);
    }
    return result;
  }, [externalPlugins]);
  const registryByCapability = useMemo(() => {
    const result = new Map<string, RegistryPlugin[]>();
    for (const plugin of registryPlugins) for (const capability of plugin.capabilities ?? []) {
      result.set(capability, [...(result.get(capability) ?? []), plugin]);
    }
    return result;
  }, [registryPlugins]);

  const refresh = useCallback(async () => {
    try {
      const response = await serviceFetch('/api/integrations');
      const payload = await response.json() as IntegrationStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not load plugin status');
      setStatus(payload);
      setStatusError('');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not load plugin status');
    }
  }, []);

  const refreshExternal = useCallback(async () => {
    setExternalLoading(true);
    try {
      const [collection, registry, settings] = await Promise.all([
        serviceRequest<PluginCollection>('/api/v1/plugins'),
        serviceRequest<{ plugins: RegistryPlugin[] }>('/api/v1/plugins/registry').catch(() => ({ plugins: [] })),
        serviceRequest<{ values: Record<string, unknown> }>('/api/v1/settings'),
      ]);
      setExternalPlugins(collection.plugins);
      setRegistryPlugins(registry.plugins ?? []);
      setDeveloperMode(settings.values['plugins.developerMode'] === true);
      setExtractorPlugin(typeof settings.values['extraction.extractorPlugin'] === 'string' ? settings.values['extraction.extractorPlugin'] : 'builtin');
      setOcrPlugin(typeof settings.values['extraction.ocrPlugin'] === 'string' ? settings.values['extraction.ocrPlugin'] : 'builtin');
      setEmbedderPlugin(typeof settings.values['embeddings.embedderPlugin'] === 'string' ? settings.values['embeddings.embedderPlugin'] : 'builtin');
      setVectorIndexPlugin(typeof settings.values['retrieval.vectorIndexPlugin'] === 'string' ? settings.values['retrieval.vectorIndexPlugin'] : 'builtin');
      setRerankerPlugin(typeof settings.values['retrieval.rerankerPlugin'] === 'string' ? settings.values['retrieval.rerankerPlugin'] : 'builtin');
      if (typeof settings.values['providers.openai-compatible.endpoint'] === 'string') setOpenaiCompatibleEndpoint(settings.values['providers.openai-compatible.endpoint']);
      if (typeof settings.values['providers.llama-cpp.endpoint'] === 'string') setLlamaCppEndpoint(settings.values['providers.llama-cpp.endpoint']);
      if (typeof settings.values['providers.llama-cpp.model'] === 'string') {
        setModels(current => ({ ...current, 'llama-cpp': settings.values['providers.llama-cpp.model'] as string }));
      }
      const loadedConcurrencies: Record<string, number> = {};
      for (const provider of PROVIDERS) {
        const value = settings.values[`providers.${provider.id}.maxConcurrency`];
        if (typeof value === 'number') loadedConcurrencies[provider.id] = value;
      }
      setConcurrencies(loadedConcurrencies);
      if (typeof settings.values['providers.llama-cpp.executablePath'] === 'string') setLlamaCppExecutablePath(settings.values['providers.llama-cpp.executablePath']);
      if (typeof settings.values['providers.llama-cpp.modelPath'] === 'string') setLlamaCppModelPath(settings.values['providers.llama-cpp.modelPath']);
      setExternalError('');
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : 'Could not load external plugins');
    } finally {
      setExternalLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); void refreshExternal(); }, [refresh, refreshExternal]);
  useEffect(() => {
    const first = status?.ollama?.models?.[0]?.name;
    if (!first) return;
    setModels(current => current.ollama ? current : { ...current, ollama: first });
  }, [status?.ollama?.models]);
  useEffect(() => {
    if (!window.quizzerDesktop) return;
    let active = true;
    void Promise.all([window.quizzerDesktop.credentials.status(), loadRememberedApiKeys()]).then(([storage, remembered]) => {
      if (!active) return;
      setCredentialStorage(storage);
      setRememberedProviders(new Set(remembered.providers));
      setApiKeys(current => ({ ...current, ...remembered.values }));
    }).catch(error => {
      if (active) setCredentialStorage({ available: false, backend: 'error', message: error instanceof Error ? error.message : 'Credential storage is unavailable.' });
    }).finally(() => { if (active) setCredentialReady(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!status) return;
    const jobs = [status.marker?.job, status.ocr?.job, status.embeddings?.job, status.ollama?.job,
      ...AGENT_PROVIDERS.map(provider => status[provider.id]?.job)].filter(Boolean);
    const runtimeBusy = ['starting', 'stopping'].includes(status['llama-cpp']?.runtime?.state ?? 'idle');
    if (!jobs.some(job => job?.state === 'working') && !runtimeBusy) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, status]);

  const runAction = async (path: string) => {
    try {
      const response = await serviceFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || 'Could not start plugin action');
      }
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not start plugin action');
    }
  };

  const configureManagedRuntime = () => getModalApi().confirm({
    title: 'Save managed llama.cpp paths?',
    content: 'Quizzer will remember these absolute paths and use them only after you explicitly confirm a start. It will not download or search for binaries or models.',
    okText: 'Save paths',
    onOk: async () => {
      await serviceJson('/api/v1/integrations/llama-cpp/runtime/configure', 'POST', {
        executablePath: llamaCppExecutablePath.trim(), modelPath: llamaCppModelPath.trim(), confirmed: true,
      });
      await refresh();
      message.success('Managed llama.cpp paths saved');
    },
  });

  const startManagedRuntime = () => getModalApi().confirm({
    title: 'Start the managed llama.cpp server?',
    content: 'Quizzer will run the already-installed executable with the selected model on 127.0.0.1 using bounded resource settings. No files will be downloaded.',
    okText: 'Start local server',
    onOk: async () => {
      await serviceJson('/api/v1/integrations/llama-cpp/runtime/start', 'POST', { confirmed: true });
      await refresh();
    },
  });

  const stopManagedRuntime = async () => {
    try {
      await serviceJson('/api/v1/integrations/llama-cpp/runtime/stop', 'POST', {});
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not stop llama.cpp');
    }
  };

  const installOllama = () => getModalApi().confirm({
    title: 'Install the Ollama runtime?',
    content: 'Quizzer will download and install Ollama from its official distribution. No generation model is downloaded until you choose one separately.',
    okText: 'Install Ollama',
    onOk: async () => {
      await serviceJson('/api/integrations/ollama/install', 'POST', { confirmed: true });
      await refresh();
    },
  });

  const pullOllamaModel = () => {
    const model = models.ollama?.trim();
    if (!model) return message.warning('Enter an Ollama model name first');
    getModalApi().confirm({
      title: `Download ${model}?`,
      content: 'Model downloads can require several gigabytes of disk space. The model stays on this device and Quizzer will not send document content to a remote provider.',
      okText: 'Download model',
      onOk: async () => {
        await serviceJson('/api/integrations/ollama/pull', 'POST', { model, confirmed: true });
        await refresh();
      },
    });
  };

  const installEmbeddingModel = () => {
    const model = status?.embeddings?.model;
    if (!model) return message.warning('Embedding settings are still loading');
    getModalApi().confirm({
      title: `Download ${model} for dense retrieval?`,
      content: model === 'bge-m3'
        ? 'The Max profile uses the multilingual bge-m3 model. This download is approximately 1.2 GB and stays on this device.'
        : 'Quizzer will install Ollama if needed and download this embedding model to this device.',
      okText: `Download ${model}`,
      onOk: async () => {
        await serviceJson('/api/integrations/embeddings/install', 'POST', { model, confirmed: true });
        await refresh();
      },
    });
  };

  const installExternalPlugin = async () => {
    if (!window.quizzerDesktop) return;
    const path = await window.quizzerDesktop.selectPluginDirectory();
    if (!path) return;
    setPluginAction('install');
    try {
      const result = await serviceJson<{ plugin: ExternalPlugin }>('/api/v1/plugins/install', 'POST', { path });
      message.success(`${result.plugin.name ?? result.plugin.id} installed`);
      await refreshExternal();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not install plugin');
    } finally {
      setPluginAction('');
    }
  };

  const runExternalAction = async (plugin: ExternalPlugin, action: 'enable' | 'disable' | 'health' | 'rollback') => {
    setPluginAction(`${plugin.id}:${action}`);
    try {
      const result = await serviceJson<{ health?: HealthResult }>(`/api/v1/plugins/${encodeURIComponent(plugin.id)}/${action}`, 'POST');
      if (result.health) {
        setHealthResults(current => ({ ...current, [plugin.id]: result.health! }));
        if (result.health.ok) message.success(`${plugin.name ?? plugin.id} is healthy`);
        else message.warning(result.health.error || `${plugin.name ?? plugin.id} failed its health check`);
      } else {
        message.success(action === 'rollback' ? `${plugin.name ?? plugin.id} rolled back and disabled` : `${plugin.name ?? plugin.id} ${action}d`);
      }
      await refreshExternal();
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : `Could not ${action} plugin`);
      return false;
    } finally {
      setPluginAction('');
    }
  };

  const confirmRegistrySecurity = (title: string, okText: string, reasons: string[]) => new Promise<boolean>(resolve => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    getModalApi().confirm({
      title,
      content: (
        <Space direction="vertical">
          <Typography.Text>Quizzer verified the signed manifest. Confirm these permissions and resource effects:</Typography.Text>
          <ul>{(reasons.length ? reasons : ['Security confirmation required']).map(reason => <li key={reason}>{reason}</li>)}</ul>
        </Space>
      ),
      okText,
      onOk: () => settle(true),
      onCancel: () => settle(false),
    });
  });

  const installRegistryPlugin = async (registryPlugin: RegistryPlugin) => {
    setPluginAction(`registry:${registryPlugin.id}:install`);
    try {
      const result = await executeTwoPhaseAction(
        confirmationToken => serviceJson<{ plugin: ExternalPlugin }>('/api/v1/plugins/install', 'POST', {
          id: registryPlugin.id,
          ...(confirmationToken ? { confirmed: true, confirmationToken } : {}),
        }),
        {
          onConfirmationRequired: reasons => confirmRegistrySecurity(
            `Install ${registryPlugin.name || registryPlugin.id}?`, 'Confirm and install', reasons,
          ),
        },
      );
      if (!result) return;
      message.success(`${result.plugin.name ?? result.plugin.id} installed`);
      await refreshExternal();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not install registry plugin');
    } finally {
      setPluginAction('');
    }
  };

  const updateRegistryPlugin = async (plugin: ExternalPlugin) => {
    setPluginAction(`${plugin.id}:update`);
    try {
      const result = await executeTwoPhaseAction(
        confirmationToken => serviceJson<{ plugin: ExternalPlugin }>(
          `/api/v1/plugins/${encodeURIComponent(plugin.id)}/update`, 'POST',
          confirmationToken ? { confirmed: true, confirmationToken } : {},
        ),
        {
          onConfirmationRequired: reasons => confirmRegistrySecurity(
            `Update ${plugin.name ?? plugin.id} to v${plugin.availableVersion || 'latest'}?`, 'Confirm and update', reasons,
          ),
        },
      );
      if (!result) return;
      message.success(`Updated ${result.plugin.name ?? plugin.name ?? plugin.id}`);
      await refreshExternal();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not update plugin');
    } finally {
      setPluginAction('');
    }
  };

  const removeExternalPlugin = (plugin: ExternalPlugin) => getModalApi().confirm({
    title: `Remove ${plugin.name ?? plugin.id}?`,
    content: 'Quizzer will disable the plugin and move it to recoverable removed storage. Its files are not permanently deleted.',
    okText: 'Remove plugin',
    okButtonProps: { danger: true },
    onOk: async () => {
      setPluginAction(`${plugin.id}:remove`);
      try {
        await serviceRequest(`/api/v1/plugins/${encodeURIComponent(plugin.id)}?confirm=true`, { method: 'DELETE' });
        setManagedPluginId(null);
        await refreshExternal();
      } finally {
        setPluginAction('');
      }
    },
  });

  const changeRemembered = (provider: (typeof API_PROVIDERS)[number], remember: boolean) => {
    if (!remember) {
      setRememberedProviders(current => {
        const next = new Set(current);
        next.delete(provider.id);
        return next;
      });
      return;
    }
    if (!credentialStorage.available) return message.warning(credentialStorage.message);
    getModalApi().confirm({
      title: `Remember ${providerName(provider.label)} credentials?`,
      content: 'Quizzer will encrypt this API key with the operating system. It is never included in exports, backups, or diagnostics.',
      okText: 'Encrypt and remember',
      onOk: () => setRememberedProviders(current => new Set(current).add(provider.id)),
    });
  };

  const providerReady = (provider: (typeof PROVIDERS)[number]) => {
    if (provider.id === 'plugin') return readyGeneratorPlugins.some(plugin => plugin.id === models.plugin);
    if (provider.id === 'ollama') {
      return Boolean(status?.ollama?.serverReady && status.ollama.models.some(model => ollamaModelMatches(model.name, models.ollama)));
    }
    if (provider.id === 'llama-cpp') {
      return Boolean(status?.['llama-cpp']?.serverReady && isNumericLoopbackEndpoint(llamaCppEndpoint) && models['llama-cpp']?.trim());
    }
    if (provider.kind === 'agent') return Boolean(status?.[provider.id as AgentProvider]?.connected);
    if (provider.id === 'openai-compatible') {
      return Boolean(models[provider.id]?.trim()) && (Boolean(apiKeys[provider.id]?.trim()) || isOpenAILoopbackEndpoint(openaiCompatibleEndpoint));
    }
    return Boolean(apiKeys[provider.id]?.trim());
  };

  const save = async () => {
    const available = PROVIDERS.filter(provider => enabledProviders[provider.id] && providerReady(provider));
    const selectedProvider = available.some(provider => provider.id === defaultProvider) ? defaultProvider : available[0]?.id ?? defaultProvider;
    setSaving(true);
    try {
      if (credentialStorage.available) for (const provider of API_PROVIDERS) {
        const value = apiKeys[provider.id]?.trim() ?? '';
        if (rememberedProviders.has(provider.id) && value) await rememberApiKey(provider.id, value);
        else await forgetRememberedApiKey(provider.id);
      }
      for (const provider of API_PROVIDERS) setApiKey(provider.id, apiKeys[provider.id]?.trim() ?? '');
      await serviceJson('/api/v1/settings', 'PATCH', { values: {
        'generation.defaultProvider': selectedProvider,
        'providers.openai-compatible.endpoint': openaiCompatibleEndpoint.trim() || 'https://api.openai.com/v1',
        'providers.llama-cpp.endpoint': llamaCppEndpoint.trim() || 'http://127.0.0.1:8080/v1',
        'providers.llama-cpp.model': models['llama-cpp']?.trim() || 'local-model',
        'extraction.marker': enabledTools.marker,
        'extraction.extractorPlugin': extractorPlugin,
        'extraction.ocr': enabledTools.ocr,
        'extraction.ocrPlugin': ocrPlugin,
        'embeddings.enabled': enabledTools.embeddings,
        'embeddings.embedderPlugin': embedderPlugin,
        'retrieval.vectorIndexPlugin': vectorIndexPlugin,
        'retrieval.rerankerPlugin': rerankerPlugin,
        ...Object.fromEntries(Object.entries(concurrencies).map(([id, val]) => [`providers.${id}.maxConcurrency`, val])),
      } });
      if (models['llama-cpp']?.trim()) {
        await serviceJson('/api/v1/integrations/llama-cpp/configure', 'POST', {
          endpoint: llamaCppEndpoint.trim() || 'http://127.0.0.1:8080/v1',
          model: models['llama-cpp'].trim(),
          confirmed: true,
        });
      }
      setProviderSettings({ defaultProvider: selectedProvider, models, enabledProviders, enabledTools });
      window.dispatchEvent(new Event('quizzer:settings-changed'));
      message.success('Plugin settings saved');
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not save plugin settings');
    } finally {
      setSaving(false);
    }
  };

  const togglePluginComponent = async (
    plugin: ExternalPlugin, checked: boolean, current: string, setComponent: ComponentSetter,
    setFeatureEnabled?: (enabled: boolean) => void,
  ) => {
    if (!checked) {
      if (current === plugin.id) setComponent('builtin');
      setFeatureEnabled?.(false);
      return;
    }
    if (!plugin.enabled && !(await runExternalAction(plugin, 'enable'))) return;
    setComponent(plugin.id);
    setFeatureEnabled?.(true);
  };

  const pluginRows = (
    capability: string, current: string, setComponent: ComponentSetter, icon: ReactNode,
    setFeatureEnabled?: (enabled: boolean) => void,
    extraActions?: (plugin: ExternalPlugin) => ReactNode,
  ) => (installedByCapability.get(capability) ?? []).map(plugin => {
    const busy = pluginAction.startsWith(`${plugin.id}:`);
    const ready = plugin.status === 'installed' && plugin.compatible;
    const active = current === plugin.id && plugin.enabled;
    return (
      <IntegrationOption
        key={`${capability}-${plugin.id}`}
        icon={icon}
        title={plugin.name ?? plugin.id}
        description={`External ${capability} plugin · ${plugin.id}`}
        state={!plugin.compatible ? 'Installed · incompatible' : plugin.status === 'broken' ? 'Installed · broken' : active ? 'Installed · active' : plugin.enabled ? 'Installed · ready' : 'Installed · disabled'}
        checked={active}
        switchLabel={`Use ${plugin.name ?? plugin.id} for ${capability}`}
        switchDisabled={!ready || busy}
        warning={!ready}
        onToggle={checked => void togglePluginComponent(plugin, checked, current, setComponent, setFeatureEnabled)}
        actions={<>{extraActions?.(plugin)}<Button size="small" aria-label={`Manage ${plugin.name ?? plugin.id}`} onClick={() => setManagedPluginId(plugin.id)}>Manage</Button></>}
      />
    );
  });

  const registryRows = (capability: string, icon: ReactNode) => {
    const available = (registryByCapability.get(capability) ?? []).filter(plugin => !externalPlugins.some(installed => (installed.registryId ?? installed.id) === plugin.id));
    if (!available.length) return null;
    return (
      <>
        <Divider orientation="left" plain>Available to install</Divider>
        {available.map(plugin => {
          const busy = pluginAction === `registry:${plugin.id}:install`;
          return (
            <IntegrationOption
              key={`registry-${capability}-${plugin.id}`}
              icon={icon}
              title={plugin.name}
              description={plugin.description || `Signed ${capability} plugin from the Quizzer registry.`}
              state={plugin.compatible ? `Available · v${plugin.version}` : 'Unavailable on this platform'}
              checked={false}
              switchLabel={`Enable ${plugin.name} after installation`}
              switchDisabled
              warning={!plugin.compatible}
              onToggle={() => undefined}
              actions={(
                <Button size="small" type="primary" icon={<CloudDownloadOutlined />} loading={busy}
                  disabled={!plugin.compatible || interfaceMode !== 'advanced' || Boolean(pluginAction)}
                  onClick={() => void installRegistryPlugin(plugin)}>Install</Button>
              )}
            />
          );
        })}
      </>
    );
  };

  const selectedOllamaModel = status?.ollama?.models.find(model => ollamaModelMatches(model.name, models.ollama));
  const managedPlugin = externalPlugins.find(plugin => plugin.id === managedPluginId);
  const modelSettingsProvider = PROVIDERS.find(provider => provider.id === modelSettingsTarget);

  const providerSettings = modelSettingsProvider ? (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {modelSettingsProvider.id === 'openai-compatible' ? (
        <Input aria-label="OpenAI-compatible base endpoint" value={openaiCompatibleEndpoint} onChange={event => setOpenaiCompatibleEndpoint(event.target.value)} addonBefore="Base endpoint" />
      ) : null}
      {modelSettingsProvider.kind === 'api' ? (
        <>
          <Input.Password aria-label={modelSettingsProvider.keyLabel} value={apiKeys[modelSettingsProvider.id]}
            onChange={event => setApiKeys(current => ({ ...current, [modelSettingsProvider.id]: event.target.value }))}
            placeholder={modelSettingsProvider.keyLabel} autoComplete="off" />
          <Input aria-label={`${providerName(modelSettingsProvider.label)} default model`} value={models[modelSettingsProvider.id]}
            onChange={event => setModels(current => ({ ...current, [modelSettingsProvider.id]: event.target.value }))}
            addonBefore="Default model" placeholder={modelSettingsProvider.defaultModel || 'Model name'} />
          <Space>
            <Switch aria-label={`Remember ${providerName(modelSettingsProvider.label)} with OS protection`}
              checked={rememberedProviders.has(modelSettingsProvider.id)} disabled={!credentialStorage.available}
              onChange={value => changeRemembered(modelSettingsProvider as (typeof API_PROVIDERS)[number], value)} />
            <Typography.Text>Remember with OS protection</Typography.Text>
          </Space>
          <Typography.Text type="secondary">{credentialStorage.message}</Typography.Text>
        </>
      ) : null}
      {modelSettingsProvider.kind === 'agent' ? (
        <Input aria-label={`${providerName(modelSettingsProvider.label)} default model`} value={models[modelSettingsProvider.id]}
          onChange={event => setModels(current => ({ ...current, [modelSettingsProvider.id]: event.target.value }))}
          addonBefore="Default model" placeholder="Use the agent default" />
      ) : null}
      {modelSettingsProvider.id === 'ollama' ? (
        <>
          <Input aria-label="Default Ollama model" value={models.ollama}
            onChange={event => setModels(current => ({ ...current, ollama: event.target.value }))}
            addonBefore="Default model" placeholder="For example: qwen3:4b" />
          {status?.ollama?.models?.length ? (
            <Space wrap>{status.ollama.models.map(model => (
              <Button key={model.name} size="small" type={ollamaModelMatches(model.name, models.ollama) ? 'primary' : 'default'}
                onClick={() => setModels(current => ({ ...current, ollama: model.name }))}>{model.name}</Button>
            ))}</Space>
          ) : <Typography.Text type="secondary">No downloaded models detected.</Typography.Text>}
          {!status?.ollama?.installed ? <Button icon={<CloudDownloadOutlined />} onClick={installOllama}>Install Ollama runtime</Button> : null}
          {models.ollama?.trim() && !selectedOllamaModel ? <Button icon={<CloudDownloadOutlined />} onClick={pullOllamaModel}>Download model</Button> : null}
          {status?.ollama?.job?.message ? <pre className="plugin-output">{status.ollama.job.message}</pre> : null}
        </>
      ) : null}
      {modelSettingsProvider.id === 'llama-cpp' ? (
        <>
          <Input aria-label="llama.cpp local endpoint" value={llamaCppEndpoint} onChange={event => setLlamaCppEndpoint(event.target.value)} addonBefore="Local endpoint" />
          <Input aria-label="llama.cpp model name" value={models['llama-cpp']}
            onChange={event => setModels(current => ({ ...current, 'llama-cpp': event.target.value }))} addonBefore="Model" />
          {status?.['llama-cpp']?.error ? <Alert type="warning" showIcon message="llama.cpp server is not ready" description={status['llama-cpp'].error} /> : null}
          {interfaceMode === 'advanced' ? (
            <>
              <Divider orientation="left" plain>Managed runtime</Divider>
              <Input aria-label="llama.cpp executable path" value={llamaCppExecutablePath} onChange={event => setLlamaCppExecutablePath(event.target.value)} addonBefore="Executable" />
              <Input aria-label="llama.cpp model file path" value={llamaCppModelPath} onChange={event => setLlamaCppModelPath(event.target.value)} addonBefore="GGUF model" />
              <Space wrap>
                <Button onClick={configureManagedRuntime} disabled={!llamaCppExecutablePath.trim() || !llamaCppModelPath.trim()}>Save managed paths</Button>
                {['running', 'starting'].includes(status?.['llama-cpp']?.runtime?.state ?? '')
                  ? <Button danger onClick={() => void stopManagedRuntime()}>Stop local server</Button>
                  : <Button type="primary" onClick={startManagedRuntime} disabled={!status?.['llama-cpp']?.runtime?.configured}>Start local server</Button>}
              </Space>
              {status?.['llama-cpp']?.runtime?.lastError ? <Alert type="error" showIcon message={status['llama-cpp'].runtime.lastError} /> : null}
              {status?.['llama-cpp']?.runtime?.output ? <pre className="plugin-output">{status['llama-cpp'].runtime.output}</pre> : null}
            </>
          ) : null}
        </>
      ) : null}
      <Divider orientation="left" plain>Resource Limits</Divider>
      <Space>
        <Typography.Text>Maximum concurrency</Typography.Text>
        <InputNumber aria-label="Maximum concurrency" min={1} max={10} value={concurrencies[modelSettingsProvider.id] ?? 2}
          onChange={value => {
            if (value !== null) setConcurrencies(current => ({ ...current, [modelSettingsProvider.id]: value }));
          }} />
      </Space>
    </Space>
  ) : null;

  const documentTab = (
    <div className="plugin-option-list">
      <IntegrationOption icon={<FileSearchOutlined />} title="Quizzer document extraction"
        description="Built-in PDF.js and text extraction. This safe fallback remains installed with Quizzer."
        state={extractorPlugin === 'builtin' ? 'Built in · active' : 'Built in · ready'} checked={extractorPlugin === 'builtin'}
        switchLabel="Use Quizzer document extraction" onToggle={checked => { if (checked) setExtractorPlugin('builtin'); }} />
      <IntegrationOption icon={<FileSearchOutlined />} title="Marker visual extraction"
        description="Optional richer local extraction for PDFs with complex layouts and images."
        state={status?.marker?.job?.state === 'working' ? 'Installing…' : status?.marker?.installed ? 'Detected · installed' : 'Not installed'}
        checked={Boolean(status?.marker?.installed && enabledTools.marker)} switchLabel="Use Marker for automatic PDF extraction"
        switchDisabled={!status?.marker?.installed || status?.marker?.job?.state === 'working'}
        onToggle={checked => setEnabledTools(current => ({ ...current, marker: checked }))}
        actions={!status?.marker?.installed && status?.marker?.job?.state !== 'working'
          ? <Button size="small" type="primary" icon={<CloudDownloadOutlined />} onClick={() => void runAction('/api/integrations/marker/install')}>Install</Button> : undefined}
        details={status?.marker?.job?.message ? <pre className="plugin-output">{status.marker.job.message}</pre> : undefined} />
      {pluginRows('extractor', extractorPlugin, setExtractorPlugin, <FileSearchOutlined />)}
      {registryRows('extractor', <FileSearchOutlined />)}
    </div>
  );

  const ocrTab = (
    <div className="plugin-option-list">
      <IntegrationOption icon={<ScanOutlined />} title="RapidOCR"
        description="Managed local OCR for labels, diagrams, and screenshots extracted from documents."
        state={status?.ocr?.job?.state === 'working' ? 'Installing…' : status?.ocr?.installed ? 'Detected · installed' : 'Not installed'}
        checked={Boolean(status?.ocr?.installed && ocrPlugin === 'builtin' && enabledTools.ocr)} switchLabel="Enable RapidOCR"
        switchDisabled={!status?.ocr?.installed || status?.ocr?.job?.state === 'working'}
        onToggle={checked => { if (checked) setOcrPlugin('builtin'); setEnabledTools(current => ({ ...current, ocr: checked })); }}
        actions={!status?.ocr?.installed && status?.ocr?.job?.state !== 'working'
          ? <Button size="small" type="primary" icon={<CloudDownloadOutlined />} onClick={() => void runAction('/api/integrations/ocr/install')}>Install</Button> : undefined}
        details={status?.ocr?.job?.message ? <pre className="plugin-output">{status.ocr.job.message}</pre> : undefined} />
      {pluginRows('ocr', ocrPlugin, setOcrPlugin, <ScanOutlined />, enabled => setEnabledTools(current => ({ ...current, ocr: enabled })))}
      {registryRows('ocr', <ScanOutlined />)}
    </div>
  );

  const embeddingsTab = (
    <div className="plugin-option-list">
      <IntegrationOption icon={<ShareAltOutlined />} title={`Ollama embeddings${status?.embeddings?.model ? ` · ${status.embeddings.model}` : ''}`}
        description="Local semantic embeddings for hybrid retrieval and duplicate filtering."
        state={status?.embeddings?.job?.state === 'working' ? 'Installing…' : status?.embeddings?.installed ? 'Detected · installed' : 'Model not installed'}
        checked={Boolean(status?.embeddings?.installed && embedderPlugin === 'builtin' && enabledTools.embeddings)} switchLabel="Enable Ollama embeddings"
        switchDisabled={!status?.embeddings?.installed || status?.embeddings?.job?.state === 'working'}
        onToggle={checked => { if (checked) setEmbedderPlugin('builtin'); setEnabledTools(current => ({ ...current, embeddings: checked })); }}
        actions={!status?.embeddings?.installed && status?.embeddings?.job?.state !== 'working'
          ? <Button size="small" type="primary" icon={<CloudDownloadOutlined />} onClick={installEmbeddingModel}>Install</Button> : undefined}
        details={status?.embeddings?.job?.message ? <pre className="plugin-output">{status.embeddings.job.message}</pre> : undefined} />
      {pluginRows('embedder', embedderPlugin, setEmbedderPlugin, <ShareAltOutlined />, enabled => setEnabledTools(current => ({ ...current, embeddings: enabled })))}
      {registryRows('embedder', <ShareAltOutlined />)}
      <Divider orientation="left" plain>Vector index</Divider>
      <IntegrationOption icon={<ShareAltOutlined />} title="LanceDB vector index" description="Quizzer's built-in local index for semantic search."
        state={vectorIndexPlugin === 'builtin' ? 'Built in · active' : 'Built in · ready'} checked={vectorIndexPlugin === 'builtin'}
        switchLabel="Use LanceDB vector index" onToggle={checked => { if (checked) setVectorIndexPlugin('builtin'); }} />
      {pluginRows('vector-index', vectorIndexPlugin, setVectorIndexPlugin, <ShareAltOutlined />)}
      {registryRows('vector-index', <ShareAltOutlined />)}
      <Divider orientation="left" plain>Result reranking</Divider>
      <IntegrationOption icon={<ShareAltOutlined />} title="Quizzer reranker" description="Built-in local ranking for relevant and diverse evidence."
        state={rerankerPlugin === 'builtin' ? 'Built in · active' : 'Built in · ready'} checked={rerankerPlugin === 'builtin'}
        switchLabel="Use Quizzer result reranker" onToggle={checked => { if (checked) setRerankerPlugin('builtin'); }} />
      {pluginRows('reranker', rerankerPlugin, setRerankerPlugin, <ShareAltOutlined />)}
      {registryRows('reranker', <ShareAltOutlined />)}
    </div>
  );

  const modelsTab = (
    <div className="plugin-option-list">
      {PROVIDERS.filter(provider => provider.id !== 'plugin').map(provider => {
        const ready = providerReady(provider);
        const agent = provider.kind === 'agent' ? status?.[provider.id as AgentProvider] : undefined;
        const working = agent?.job?.state === 'working' || (provider.id === 'ollama' && status?.ollama?.job?.state === 'working');
        const actions = (
          <>
            {provider.id === 'ollama' && !status?.ollama?.installed && !working
              ? <Button size="small" type="primary" icon={<CloudDownloadOutlined />} onClick={installOllama}>Install</Button> : null}
            {provider.kind === 'agent' && provider.id !== 'codex' && !agent?.installed && !working
              ? <Button size="small" type="primary" icon={<CloudDownloadOutlined />} onClick={() => void runAction(`/api/integrations/${provider.id}/install`)}>Install</Button> : null}
            {provider.kind === 'agent' && agent?.installed && !agent.connected && !working
              ? <Button size="small" type="primary" icon={<LoginOutlined />} onClick={() => void runAction(`/api/integrations/${provider.id}/connect`)}>Connect</Button> : null}
            {provider.id === 'codex' && !agent?.installed
              ? <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>Detect again</Button> : null}
            <Button size="small" icon={<SettingOutlined />} aria-label={`Settings for ${providerName(provider.label)}`}
              onClick={() => setModelSettingsTarget(provider.id)}>Settings</Button>
            {ready && enabledProviders[provider.id] ? (
              <Button size="small" type={defaultProvider === provider.id ? 'primary' : 'default'} disabled={defaultProvider === provider.id}
                onClick={() => setDefaultProvider(provider.id)}>{defaultProvider === provider.id ? 'Default' : 'Make default'}</Button>
            ) : null}
          </>
        );
        return (
          <IntegrationOption key={provider.id} icon={<RobotOutlined />} title={providerName(provider.label)} description={provider.description}
            state={working ? 'Working…' : ready ? (enabledProviders[provider.id] ? 'Detected · enabled' : 'Detected · disabled')
              : provider.kind === 'api' ? 'Settings required' : provider.kind === 'agent' && agent?.installed ? 'Sign-in required' : 'Not ready'}
            checked={ready && enabledProviders[provider.id]} switchLabel={`Enable ${providerName(provider.label)}`}
            switchDisabled={!ready || working} onToggle={checked => setEnabledProviders(current => ({ ...current, [provider.id]: checked }))}
            actions={actions} details={agent?.job?.message ? <pre className="plugin-output">{agent.job.message}</pre> : undefined} />
        );
      })}
      {pluginRows(
        'generator', models.plugin, value => setModels(current => ({ ...current, plugin: value })), <RobotOutlined />,
        enabled => setEnabledProviders(current => ({ ...current, plugin: enabled })),
        plugin => models.plugin === plugin.id && enabledProviders.plugin ? (
          <Button size="small" type={defaultProvider === 'plugin' ? 'primary' : 'default'} disabled={defaultProvider === 'plugin'}
            onClick={() => setDefaultProvider('plugin')}>{defaultProvider === 'plugin' ? 'Default' : 'Make default'}</Button>
        ) : null,
      )}
      {registryRows('generator', <RobotOutlined />)}
      {externalPlugins.filter(plugin => !(plugin.capabilities ?? []).some(capability => ['extractor', 'ocr', 'embedder', 'vector-index', 'reranker', 'generator'].includes(capability))).map(plugin => (
        <IntegrationOption key={`other-${plugin.id}`} icon={<ApiOutlined />} title={plugin.name ?? plugin.id}
          description="Installed plugin with no selectable Quizzer capability." state={plugin.enabled ? 'Installed · enabled' : 'Installed · disabled'}
          checked={plugin.enabled} switchLabel={`Enable ${plugin.name ?? plugin.id}`}
          switchDisabled={plugin.status !== 'installed' || !plugin.compatible || pluginAction.startsWith(`${plugin.id}:`)}
          onToggle={checked => void runExternalAction(plugin, checked ? 'enable' : 'disable')}
          actions={<Button size="small" aria-label={`Manage ${plugin.name ?? plugin.id}`} onClick={() => setManagedPluginId(plugin.id)}>Manage</Button>} />
      ))}
    </div>
  );

  return (
    <>
      <Modal open title={<Space><ApiOutlined /> Plugins & models</Space>} width={940} onCancel={onClose} onOk={() => void save()}
        confirmLoading={saving} okButtonProps={{ disabled: !credentialReady }} okText="Save settings">
        <div className="plugin-modal-intro">
          <Typography.Text type="secondary">Choose a capability, then enable a detected option or install one. Configuration stays behind each option’s Settings button.</Typography.Text>
          <Space wrap>
            <Button size="small" icon={<FolderOpenOutlined />} loading={pluginAction === 'install'}
              disabled={interfaceMode !== 'advanced' || !window.quizzerDesktop || Boolean(pluginAction)}
              onClick={() => void installExternalPlugin()}>Install local plugin</Button>
            <Button size="small" icon={<ReloadOutlined />} loading={externalLoading}
              onClick={() => { void refresh(); void refreshExternal(); }}>Detect again</Button>
          </Space>
        </div>
        {interfaceMode !== 'advanced' ? <Typography.Text type="secondary">Advanced mode is required to install third-party plugins.</Typography.Text> : null}
        {statusError ? <Alert type="error" showIcon message={statusError} action={<Button size="small" onClick={() => void refresh()}>Retry</Button>} /> : null}
        {externalError ? <Alert type="error" showIcon message={externalError} action={<Button size="small" onClick={() => void refreshExternal()}>Retry</Button>} /> : null}
        {!status && !statusError ? <div className="plugin-loading"><Spin /></div> : (
          <Tabs defaultActiveKey="document-extraction" items={[
            { key: 'document-extraction', label: 'Document extraction', children: documentTab },
            { key: 'image-ocr', label: 'Image OCR', children: ocrTab },
            { key: 'embeddings', label: 'Embeddings', children: embeddingsTab },
            { key: 'models', label: 'Models', children: modelsTab },
          ]} />
        )}
      </Modal>

      <Modal open={Boolean(modelSettingsProvider)}
        title={modelSettingsProvider ? `${providerName(modelSettingsProvider.label)} settings` : 'Model settings'}
        onCancel={() => setModelSettingsTarget(null)} footer={<Button type="primary" onClick={() => setModelSettingsTarget(null)}>Done</Button>}>
        {providerSettings}
      </Modal>

      <Modal open={Boolean(managedPlugin)} title={managedPlugin ? `Manage ${managedPlugin.name ?? managedPlugin.id}` : 'Manage plugin'}
        width={680} onCancel={() => setManagedPluginId(null)} footer={<Button onClick={() => setManagedPluginId(null)}>Close</Button>}>
        {managedPlugin ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              {managedPlugin.version ? <Tag>v{managedPlugin.version}</Tag> : null}
              <Tag color={managedPlugin.trust === 'signed' ? 'success' : 'warning'}>{managedPlugin.trust === 'signed' ? 'Signed' : 'Unsigned local'}</Tag>
              <Tag color={managedPlugin.compatible ? 'blue' : 'error'}>{managedPlugin.compatible ? 'Compatible' : 'Incompatible'}</Tag>
              {(managedPlugin.capabilities ?? []).map(capability => <Tag key={capability}>{capability}</Tag>)}
            </Space>
            {developerMode && managedPlugin.trust !== 'signed' ? <Alert type="warning" showIcon message="Advanced Developer Mode is active for this unsigned plugin." /> : null}
            {managedPlugin.warning || managedPlugin.error ? <Alert type={managedPlugin.status === 'broken' ? 'error' : 'warning'} showIcon message={managedPlugin.warning || managedPlugin.error} /> : null}
            {managedPlugin.resources ? <Typography.Text type="secondary">Estimated resources: {managedPlugin.resources.memoryMB.toLocaleString()} MB memory · {managedPlugin.resources.diskMB.toLocaleString()} MB disk</Typography.Text> : null}
            {managedPlugin.permissions ? (
              <div className="plugin-permissions">
                <Typography.Text strong>Declared permissions</Typography.Text>
                <Space wrap>
                  {managedPlugin.permissions.filesystem.map(value => <Tag key={`fs-${value}`}>Files: {value}</Tag>)}
                  {managedPlugin.permissions.network.map(value => <Tag color="gold" key={`net-${value}`}>Network: {value}</Tag>)}
                  {managedPlugin.permissions.secrets.map(value => <Tag color="purple" key={`secret-${value}`}>Secret: {value}</Tag>)}
                  {managedPlugin.permissions.subprocess ? <Tag color="volcano">Subprocess</Tag> : null}
                </Space>
              </div>
            ) : null}
            {healthResults[managedPlugin.id] ? (
              <Alert type={healthResults[managedPlugin.id].ok ? 'success' : 'error'} showIcon
                message={healthResults[managedPlugin.id].ok ? `Healthy · ${healthResults[managedPlugin.id].durationMs} ms` : 'Health check failed'}
                description={healthResults[managedPlugin.id].error} />
            ) : null}
            <Space wrap>
              <Space>
                <Switch checked={managedPlugin.enabled}
                  disabled={!managedPlugin.compatible || managedPlugin.status === 'broken' || Boolean(pluginAction)}
                  aria-label={`Enable ${managedPlugin.name ?? managedPlugin.id}`}
                  onChange={checked => void runExternalAction(managedPlugin, checked ? 'enable' : 'disable')} />
                <Typography.Text>Enabled</Typography.Text>
              </Space>
              {managedPlugin.updateAvailable ? <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => void updateRegistryPlugin(managedPlugin)}>Update to v{managedPlugin.availableVersion}</Button> : null}
              <Button onClick={() => void runExternalAction(managedPlugin, 'health')}>Health check</Button>
              <Button icon={<RollbackOutlined />} disabled={!managedPlugin.rollbackAvailable} onClick={() => void runExternalAction(managedPlugin, 'rollback')}>Rollback</Button>
              <Button danger icon={<DeleteOutlined />} onClick={() => removeExternalPlugin(managedPlugin)}>Remove</Button>
            </Space>
          </Space>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Plugin is no longer installed" />}
      </Modal>
    </>
  );
}
