import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Divider, Input, Modal, Select, Space, Spin, Switch, Tag, Typography } from 'antd';
import { ApiOutlined, CheckCircleOutlined, CloudDownloadOutlined, DeleteOutlined, FolderOpenOutlined, LoginOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import type { GenerationProvider, InterfaceMode } from '../types';
import {
  AGENT_PROVIDERS, API_PROVIDERS, PROVIDERS, getApiKey, getProviderSettings,
  migrateLegacyGeminiKey, setApiKey, setProviderSettings, type AgentProvider,
} from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';
import { serviceJson, serviceRequest } from '../utils/serviceApi';

type JobState = 'idle' | 'working' | 'complete' | 'error';
type AgentStatus = { installed: boolean; connected: boolean; job: { state: JobState; message: string } };
interface IntegrationStatus {
  marker: { installed: boolean; managed: boolean; job: { state: JobState; message: string } };
  ocr: { installed: boolean; managed: boolean; job: { state: JobState; message: string } };
  codex: AgentStatus;
  'claude-agent': AgentStatus;
  'antigravity-agent': AgentStatus;
  embeddings: { installed: boolean; runtimeInstalled: boolean; job: { state: JobState; message: string } };
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
  compatible: boolean;
  status: 'installed' | 'blocked' | 'broken';
  warning?: string;
  error?: string;
  rollbackAvailable?: boolean;
}

interface PluginCollection { plugins: ExternalPlugin[]; }
interface HealthResult { ok: boolean; result?: unknown; error?: string; durationMs: number; }

interface Props { interfaceMode: InterfaceMode; onClose: () => void; }

const statusTag = (ready: boolean, working: boolean, readyText: string) => (
  <Tag color={working ? 'processing' : ready ? 'success' : 'default'}>
    {working ? 'Working…' : ready ? readyText : 'Not configured'}
  </Tag>
);

export default function PluginsModal({ interfaceMode, onClose }: Props) {
  migrateLegacyGeminiKey();
  const initial = getProviderSettings();
  const [defaultProvider, setDefaultProvider] = useState(initial.defaultProvider);
  const [models, setModels] = useState(initial.models);
  const [enabledProviders, setEnabledProviders] = useState(initial.enabledProviders);
  const [enabledTools, setEnabledTools] = useState(initial.enabledTools);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => Object.fromEntries(API_PROVIDERS.map(provider => [provider.id, getApiKey(provider.id)])));
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [externalPlugins, setExternalPlugins] = useState<ExternalPlugin[]>([]);
  const [externalError, setExternalError] = useState('');
  const [externalLoading, setExternalLoading] = useState(true);
  const [developerMode, setDeveloperMode] = useState(false);
  const [pluginAction, setPluginAction] = useState('');
  const [healthResults, setHealthResults] = useState<Record<string, HealthResult>>({});
  const message = getMessageApi();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/integrations');
      const payload = await response.json() as IntegrationStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not load plugin status');
      setStatus(payload);
      setStatusError('');
    } catch (error) {
      setStatusError((error as Error).message);
    }
  }, []);

  const refreshExternal = useCallback(async () => {
    setExternalLoading(true);
    try {
      const [collection, settings] = await Promise.all([
        serviceRequest<PluginCollection>('/api/v1/plugins'),
        serviceRequest<{ values: Record<string, unknown> }>('/api/v1/settings'),
      ]);
      setExternalPlugins(collection.plugins);
      setDeveloperMode(settings.values['plugins.developerMode'] === true);
      setExternalError('');
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : 'Could not load external plugins');
    } finally {
      setExternalLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); void refreshExternal(); }, [refresh, refreshExternal]);
  useEffect(() => {
    if (!status) return;
    const jobs = [status.marker.job, status.ocr?.job, status.embeddings?.job, ...AGENT_PROVIDERS.map(provider => status[provider.id]?.job)].filter(Boolean);
    if (!jobs.some(job => job.state === 'working')) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, status]);

  const start = async (path: string) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || 'Could not start plugin action');
    }
    await refresh();
  };

  const runAction = async (path: string) => {
    try { await start(path); }
    catch (error) { message.error((error as Error).message); }
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
      const result = await serviceJson<{ plugin?: ExternalPlugin; health?: HealthResult }>(
        `/api/v1/plugins/${encodeURIComponent(plugin.id)}/${action}`,
        'POST',
      );
      if (result.health) {
        setHealthResults(current => ({ ...current, [plugin.id]: result.health! }));
        if (result.health.ok) message.success(`${plugin.name ?? plugin.id} is healthy`);
        else message.warning(result.health.error || `${plugin.name ?? plugin.id} failed its health check`);
      } else {
        message.success(action === 'rollback' ? `${plugin.name ?? plugin.id} rolled back and disabled` : `${plugin.name ?? plugin.id} ${action}d`);
      }
      await refreshExternal();
    } catch (error) {
      message.error(error instanceof Error ? error.message : `Could not ${action} plugin`);
    } finally {
      setPluginAction('');
    }
  };

  const removeExternalPlugin = (plugin: ExternalPlugin) => Modal.confirm({
    title: `Remove ${plugin.name ?? plugin.id}?`,
    content: 'Quizzer will disable the plugin and move it to recoverable removed storage. Its files are not permanently deleted.',
    okText: 'Remove plugin',
    okButtonProps: { danger: true },
    onOk: async () => {
      setPluginAction(`${plugin.id}:remove`);
      try {
        await serviceRequest(`/api/v1/plugins/${encodeURIComponent(plugin.id)}?confirm=true`, { method: 'DELETE' });
        message.success(`${plugin.name ?? plugin.id} removed`);
        setHealthResults(current => {
          const next = { ...current };
          delete next[plugin.id];
          return next;
        });
        await refreshExternal();
      } catch (error) {
        message.error(error instanceof Error ? error.message : 'Could not remove plugin');
        throw error;
      } finally {
        setPluginAction('');
      }
    },
  });

  const save = () => {
    for (const provider of API_PROVIDERS) setApiKey(provider.id, apiKeys[provider.id]?.trim() ?? '');
    const available = PROVIDERS.filter(provider => enabledProviders[provider.id] && (provider.kind === 'api'
      ? Boolean(apiKeys[provider.id]?.trim())
      : Boolean(status?.[provider.id as AgentProvider]?.connected)));
    setProviderSettings({
      defaultProvider: available.some(provider => provider.id === defaultProvider) ? defaultProvider : available[0]?.id ?? defaultProvider,
      models, enabledProviders, enabledTools,
    });
    message.success('Plugin settings saved');
    onClose();
  };

  const markerWorking = status?.marker.job.state === 'working';
  const ocrWorking = status?.ocr?.job.state === 'working';
  const embeddingsWorking = status?.embeddings?.job.state === 'working';
  const configuredProviderOptions = PROVIDERS.filter(provider => enabledProviders[provider.id] && (provider.kind === 'api'
    ? Boolean(apiKeys[provider.id]?.trim())
    : Boolean(status?.[provider.id as AgentProvider]?.connected)));
  const visibleDefaultProvider = configuredProviderOptions.some(provider => provider.id === defaultProvider)
    ? defaultProvider
    : configuredProviderOptions[0]?.id;

  return (
    <Modal open title={<Space><ApiOutlined /> Plugins & models</Space>} width={900} onCancel={onClose} onOk={save} okText="Save settings">
      <Typography.Paragraph type="secondary">
        Connect signed-in CLI agents or enter API keys without editing terminal configuration. API keys live only in this browser tab.
      </Typography.Paragraph>
      {statusError && <Alert type="error" showIcon message={statusError} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>Retry</Button>} />}
      {!status && !statusError ? <div className="plugin-loading"><Spin /></div> : <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <section className="plugin-card">
          <div className="plugin-card-heading">
            <div><Typography.Title level={5}>Marker PDF</Typography.Title><Typography.Text type="secondary">Extracts PDF text, layout, and images before quiz generation.</Typography.Text></div>
            {statusTag(Boolean(status?.marker.installed), Boolean(markerWorking), status?.marker.managed ? 'Installed by Quizzer' : 'Installed')}
          </div>
          {!status?.marker.installed && !markerWorking && <Button icon={<CloudDownloadOutlined />} onClick={() => void runAction('/api/integrations/marker/install')}>Install Marker</Button>}
          {status?.marker.installed && <Space><Switch checked={enabledTools.marker} onChange={value => setEnabledTools(current => ({ ...current, marker: value }))} /><Typography.Text>Enabled</Typography.Text></Space>}
          {markerWorking && <Space><Spin size="small" /> Installing Marker…</Space>}
          {status?.marker.job.message && status.marker.job.state !== 'idle' && (
            <Alert showIcon type={status.marker.job.state === 'error' ? 'error' : status.marker.job.state === 'complete' ? 'success' : 'info'}
              message={status.marker.job.state === 'working' ? 'Installing Marker' : status.marker.job.state === 'complete' ? 'Marker ready' : 'Installation failed'}
              description={<pre className="plugin-output">{status.marker.job.message}</pre>} />
          )}
        </section>

        <section className="plugin-card">
          <div className="plugin-card-heading">
            <div><Typography.Title level={5}>Image OCR</Typography.Title><Typography.Text type="secondary">Optionally uses RapidOCR locally to read labels, diagrams, and screenshots extracted by Marker. Quizzer does not install or run OCR unless you choose it.</Typography.Text></div>
            {statusTag(Boolean(status?.ocr?.installed), Boolean(ocrWorking), 'Installed by Quizzer')}
          </div>
          {!status?.ocr?.installed && !ocrWorking && <Button icon={<CloudDownloadOutlined />} onClick={() => void runAction('/api/integrations/ocr/install')}>Install Image OCR</Button>}
          {status?.ocr?.installed && <Space><Switch checked={enabledTools.ocr} onChange={value => setEnabledTools(current => ({ ...current, ocr: value }))} /><Typography.Text>Enabled</Typography.Text></Space>}
          {ocrWorking && <Space><Spin size="small" /> Installing Image OCR…</Space>}
          {status?.ocr?.job.message && status.ocr.job.state !== 'idle' && (
            <Alert showIcon type={status.ocr.job.state === 'error' ? 'error' : status.ocr.job.state === 'complete' ? 'success' : 'info'}
              message={status.ocr.job.state === 'working' ? 'Installing Image OCR' : status.ocr.job.state === 'complete' ? 'Image OCR ready' : 'Installation failed'}
              description={<pre className="plugin-output">{status.ocr.job.message}</pre>} />
          )}
        </section>

        <section className="plugin-card">
          <div className="plugin-card-heading">
            <div><Typography.Title level={5}>Semantic duplicate filter</Typography.Title><Typography.Text type="secondary">Uses the lightweight all-minilm model locally. Exact and token-based filtering remain active without it.</Typography.Text></div>
            {statusTag(Boolean(status?.embeddings?.installed), Boolean(embeddingsWorking), 'Installed')}
          </div>
          {!status?.embeddings?.installed && !embeddingsWorking && <Button icon={<CloudDownloadOutlined />}
            onClick={() => void runAction('/api/integrations/embeddings/install')}>
            {status?.embeddings?.runtimeInstalled ? 'Install all-minilm' : 'Install Ollama + all-minilm'}
          </Button>}
          {status?.embeddings?.installed && <Space><Switch checked={enabledTools.embeddings} onChange={value => setEnabledTools(current => ({ ...current, embeddings: value }))} /><Typography.Text>Enabled</Typography.Text></Space>}
          {embeddingsWorking && <Space><Spin size="small" /> Installing semantic filter…</Space>}
          {status?.embeddings?.job.message && status.embeddings.job.state !== 'idle' && <pre className="plugin-output">{status.embeddings.job.message}</pre>}
        </section>

        <Divider orientation="left" plain>Signed-in agents</Divider>
        {AGENT_PROVIDERS.map(provider => {
          const agent = status?.[provider.id];
          const working = agent?.job.state === 'working';
          const loginUrl = agent?.job.message.match(/https:\/\/[^\s]+/)?.[0];
          return <section className="plugin-card" key={provider.id}>
            <div className="plugin-card-heading">
              <div><Typography.Title level={5}>{provider.label.replace(' – ', ' ')}</Typography.Title><Typography.Text type="secondary">{provider.description} No API key is required.</Typography.Text></div>
              {statusTag(Boolean(agent?.connected), Boolean(working), 'Connected')}
            </div>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input value={models[provider.id]} onChange={event => setModels(current => ({ ...current, [provider.id]: event.target.value }))} addonBefore="Default model" placeholder="Use the agent default" />
              <Space wrap>
                {provider.id !== 'codex' && !agent?.installed && !working && <Button icon={<CloudDownloadOutlined />} onClick={() => void runAction(`/api/integrations/${provider.id}/install`)}>Install {provider.label.split(' ')[0]}</Button>}
                {agent?.installed && !agent.connected && !working && <Button icon={<LoginOutlined />} onClick={() => void runAction(`/api/integrations/${provider.id}/connect`)}>Connect {provider.label.split(' ')[0]}</Button>}
                {working && <Space><Spin size="small" /> Working…</Space>}
                {agent?.connected && <Space><Switch checked={enabledProviders[provider.id]} onChange={value => setEnabledProviders(current => ({ ...current, [provider.id]: value }))} /><Typography.Text>Enabled</Typography.Text></Space>}
              </Space>
              {loginUrl && working && <Typography.Link href={loginUrl} target="_blank" rel="noreferrer">Open the sign-in page</Typography.Link>}
              {agent?.job.message && agent.job.state !== 'idle' && <pre className="plugin-output">{agent.job.message}</pre>}
            </Space>
          </section>;
        })}

        <Divider orientation="left" plain>API providers</Divider>
        {API_PROVIDERS.map(provider => <section className="plugin-card" key={provider.id}>
          <div className="plugin-card-heading">
            <div><Typography.Title level={5}>{provider.label.replace(' – ', ' ')}</Typography.Title><Typography.Text type="secondary">{provider.description}</Typography.Text></div>
            {statusTag(Boolean(apiKeys[provider.id]?.trim()), false, 'Connected')}
          </div>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.Password value={apiKeys[provider.id]} onChange={event => setApiKeys(current => ({ ...current, [provider.id]: event.target.value }))} placeholder={provider.keyLabel} autoComplete="off" />
            <Input value={models[provider.id]} onChange={event => setModels(current => ({ ...current, [provider.id]: event.target.value }))} addonBefore="Default model" placeholder={provider.defaultModel} />
            {!!apiKeys[provider.id]?.trim() && <Space><Switch checked={enabledProviders[provider.id]} onChange={value => setEnabledProviders(current => ({ ...current, [provider.id]: value }))} /><Typography.Text>Enabled</Typography.Text></Space>}
          </Space>
        </section>)}

        <Divider orientation="left" plain>External plugins</Divider>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          External plugins run out of process with declared permissions and verified file hashes. Signed registry plugins are trusted normally; unsigned local plugins require Advanced Developer Mode.
        </Typography.Paragraph>
        {developerMode && <Alert type="warning" showIcon message="Advanced Developer Mode is active"
          description="Unsigned local plugins can execute code. Review every capability, permission, and file hash before installation." />}
        {externalError && <Alert type="error" showIcon message={externalError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshExternal()}>Retry</Button>} />}
        <Space wrap>
          <Button icon={<FolderOpenOutlined />} loading={pluginAction === 'install'}
            disabled={interfaceMode !== 'advanced' || !window.quizzerDesktop || Boolean(pluginAction)}
            onClick={() => void installExternalPlugin()}>Install local plugin</Button>
          <Button icon={<ReloadOutlined />} loading={externalLoading} onClick={() => void refreshExternal()}>Refresh</Button>
        </Space>
        {interfaceMode !== 'advanced' && <Typography.Text type="secondary">Switch to Advanced mode to install local plugins.</Typography.Text>}
        {!window.quizzerDesktop && <Typography.Text type="secondary">Desktop directory selection is unavailable here. Install with <Typography.Text code>quizzer plugins install &lt;directory&gt;</Typography.Text>.</Typography.Text>}
        {externalLoading && !externalPlugins.length ? <div className="plugin-loading"><Spin /></div> : !externalPlugins.length && !externalError ? (
          <Alert type="info" showIcon message="No external plugins installed" description="Quizzer's built-in extraction, retrieval, and provider components remain available above." />
        ) : externalPlugins.map(plugin => {
          const busy = pluginAction.startsWith(`${plugin.id}:`);
          const health = healthResults[plugin.id];
          const permissions = plugin.permissions;
          return <section className={`plugin-card${plugin.status !== 'installed' || !plugin.compatible ? ' plugin-card-warning' : ''}`} key={plugin.id}>
            <div className="plugin-card-heading">
              <div>
                <Typography.Title level={5}>{plugin.name ?? plugin.id}</Typography.Title>
                <Space size={[4, 4]} wrap>
                  {plugin.version && <Tag>v{plugin.version}</Tag>}
                  <Tag color={plugin.trust === 'signed' ? 'success' : 'warning'}>{plugin.trust === 'signed' ? 'Signed' : 'Unsigned local'}</Tag>
                  <Tag color={plugin.compatible ? 'blue' : 'error'}>{plugin.compatible ? 'Compatible' : 'Incompatible'}</Tag>
                  {plugin.capabilities?.map(capability => <Tag key={capability}>{capability}</Tag>)}
                </Space>
              </div>
              <Tag color={plugin.status === 'installed' && plugin.enabled ? 'success' : plugin.status === 'broken' ? 'error' : 'warning'}>
                {plugin.status === 'broken' ? 'Broken' : plugin.enabled ? 'Enabled' : plugin.status === 'blocked' ? 'Blocked' : 'Disabled'}
              </Tag>
            </div>
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              {(plugin.warning || plugin.error) && <Alert type={plugin.status === 'broken' ? 'error' : 'warning'} showIcon message={plugin.warning || plugin.error} />}
              {plugin.resources && <Typography.Text type="secondary">
                Estimated resources: {plugin.resources.memoryMB.toLocaleString()} MB memory · {plugin.resources.diskMB.toLocaleString()} MB disk
                {!!plugin.resources.accelerators?.length && ` · ${plugin.resources.accelerators.join(', ')}`}
              </Typography.Text>}
              {permissions && <div className="plugin-permissions">
                <Typography.Text strong>Declared permissions</Typography.Text>
                <Space size={[4, 4]} wrap>
                  {permissions.filesystem.map(value => <Tag key={`fs-${value}`}>Files: {value}</Tag>)}
                  {permissions.network.map(value => <Tag color="gold" key={`net-${value}`}>Network: {value}</Tag>)}
                  {permissions.secrets.map(value => <Tag color="purple" key={`secret-${value}`}>Secret: {value}</Tag>)}
                  {permissions.subprocess && <Tag color="volcano">Subprocess</Tag>}
                  {!permissions.filesystem.length && !permissions.network.length && !permissions.secrets.length && !permissions.subprocess && <Tag color="green">No elevated permissions</Tag>}
                </Space>
              </div>}
              {health && <Alert showIcon icon={health.ok ? <CheckCircleOutlined /> : undefined} type={health.ok ? 'success' : 'error'}
                message={health.ok ? `Healthy · ${health.durationMs} ms` : 'Health check failed'} description={health.error} />}
              <Space wrap>
                <Button disabled={Boolean(pluginAction)} loading={busy && pluginAction.endsWith(':health')} onClick={() => void runExternalAction(plugin, 'health')}>Health check</Button>
                <Button disabled={Boolean(pluginAction) || !plugin.compatible || plugin.status === 'broken'} loading={busy && (pluginAction.endsWith(':enable') || pluginAction.endsWith(':disable'))}
                  onClick={() => void runExternalAction(plugin, plugin.enabled ? 'disable' : 'enable')}>{plugin.enabled ? 'Disable' : 'Enable'}</Button>
                <Button icon={<RollbackOutlined />} disabled={Boolean(pluginAction) || !plugin.rollbackAvailable} loading={busy && pluginAction.endsWith(':rollback')} onClick={() => void runExternalAction(plugin, 'rollback')}>Rollback</Button>
                <Button danger icon={<DeleteOutlined />} disabled={Boolean(pluginAction)} loading={busy && pluginAction.endsWith(':remove')} onClick={() => removeExternalPlugin(plugin)}>Remove</Button>
              </Space>
            </Space>
          </section>;
        })}

        <Divider style={{ margin: '4px 0' }} />
        {!!configuredProviderOptions.length && <div>
          <Typography.Text strong>Default generation provider</Typography.Text>
          <Select value={visibleDefaultProvider} onChange={(value: GenerationProvider) => setDefaultProvider(value)} style={{ display: 'block', width: '100%', marginTop: 8 }}
            options={configuredProviderOptions.map(provider => ({ label: provider.label, value: provider.id }))} />
        </div>}
        {!configuredProviderOptions.length && <Typography.Text type="secondary">Connect a provider above to make it available for generation.</Typography.Text>}
      </Space>}
    </Modal>
  );
}
