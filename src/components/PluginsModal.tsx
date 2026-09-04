import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Divider, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { ApiOutlined, CloudDownloadOutlined, LoginOutlined, ReloadOutlined } from '@ant-design/icons';
import type { GenerationProvider } from '../types';
import {
  AGENT_PROVIDERS, API_PROVIDERS, PROVIDERS, getApiKey, getProviderSettings,
  migrateLegacyGeminiKey, setApiKey, setProviderSettings, type AgentProvider,
} from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';

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

interface Props { onClose: () => void; }

const statusTag = (ready: boolean, working: boolean, readyText: string) => (
  <Tag color={working ? 'processing' : ready ? 'success' : 'default'}>
    {working ? 'Working…' : ready ? readyText : 'Not configured'}
  </Tag>
);

export default function PluginsModal({ onClose }: Props) {
  migrateLegacyGeminiKey();
  const initial = getProviderSettings();
  const [defaultProvider, setDefaultProvider] = useState(initial.defaultProvider);
  const [models, setModels] = useState(initial.models);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => Object.fromEntries(API_PROVIDERS.map(provider => [provider.id, getApiKey(provider.id)])));
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState('');
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

  useEffect(() => { void refresh(); }, [refresh]);
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

  const save = () => {
    for (const provider of API_PROVIDERS) setApiKey(provider.id, apiKeys[provider.id]?.trim() ?? '');
    const available = PROVIDERS.filter(provider => provider.kind === 'api'
      ? Boolean(apiKeys[provider.id]?.trim())
      : Boolean(status?.[provider.id as AgentProvider]?.connected));
    setProviderSettings({ defaultProvider: available.some(provider => provider.id === defaultProvider) ? defaultProvider : available[0]?.id ?? defaultProvider, models });
    message.success('Plugin settings saved');
    onClose();
  };

  const markerWorking = status?.marker.job.state === 'working';
  const ocrWorking = status?.ocr?.job.state === 'working';
  const embeddingsWorking = status?.embeddings?.job.state === 'working';
  const configuredProviderOptions = PROVIDERS.filter(provider => provider.kind === 'api'
    ? Boolean(apiKeys[provider.id]?.trim())
    : Boolean(status?.[provider.id as AgentProvider]?.connected));
  const visibleDefaultProvider = configuredProviderOptions.some(provider => provider.id === defaultProvider)
    ? defaultProvider
    : configuredProviderOptions[0]?.id;

  return (
    <Modal open title={<Space><ApiOutlined /> Plugins & models</Space>} width={800} onCancel={onClose} onOk={save} okText="Save settings">
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
          </Space>
        </section>)}

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
