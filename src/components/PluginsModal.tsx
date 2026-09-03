import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Divider, Input, Modal, Radio, Space, Spin, Tag, Typography } from 'antd';
import { ApiOutlined, CloudDownloadOutlined, LoginOutlined, ReloadOutlined } from '@ant-design/icons';
import { getGeminiApiKey, getProviderSettings, setGeminiApiKey, setProviderSettings } from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';

type JobState = 'idle' | 'working' | 'complete' | 'error';
interface IntegrationStatus {
  marker: { installed: boolean; managed: boolean; job: { state: JobState; message: string } };
  codex: { installed: boolean; connected: boolean; job: { state: JobState; message: string } };
  gemini: { available: boolean };
}

interface Props { onClose: () => void; }

const statusTag = (ready: boolean, working: boolean, readyText: string) => (
  <Tag color={working ? 'processing' : ready ? 'success' : 'default'}>
    {working ? 'Working…' : ready ? readyText : 'Not configured'}
  </Tag>
);

export default function PluginsModal({ onClose }: Props) {
  const initial = getProviderSettings();
  const [defaultProvider, setDefaultProvider] = useState(initial.defaultProvider);
  const [codexModel, setCodexModel] = useState(initial.codexModel);
  const [geminiModel, setGeminiModel] = useState(initial.geminiModel);
  const [geminiKey, setGeminiKeyState] = useState(getGeminiApiKey);
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
    if (!status || (status.marker.job.state !== 'working' && status.codex.job.state !== 'working')) return;
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

  const installMarker = async () => {
    try { await start('/api/integrations/marker/install'); }
    catch (error) { message.error((error as Error).message); }
  };

  const connectCodex = async () => {
    try { await start('/api/integrations/codex/connect'); }
    catch (error) { message.error((error as Error).message); }
  };

  const save = () => {
    setProviderSettings({ defaultProvider, codexModel: codexModel.trim(), geminiModel: geminiModel.trim() || 'gemini-2.5-flash' });
    setGeminiApiKey(geminiKey.trim());
    message.success('Plugin settings saved');
    onClose();
  };

  const codexWorking = status?.codex.job.state === 'working';
  const markerWorking = status?.marker.job.state === 'working';
  const loginUrl = status?.codex.job.message.match(/https:\/\/[^\s]+/)?.[0];

  return (
    <Modal open title={<Space><ApiOutlined /> Plugins & models</Space>} width={760} onCancel={onClose} onOk={save} okText="Save settings">
      <Typography.Paragraph type="secondary">
        Connect generation providers and manage local document tools here. Choose the provider again when creating each test.
      </Typography.Paragraph>
      {statusError && <Alert type="error" showIcon message={statusError} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>Retry</Button>} />}
      {!status && !statusError ? <div className="plugin-loading"><Spin /></div> : <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <section className="plugin-card">
          <div className="plugin-card-heading">
            <div><Typography.Title level={5}>Marker PDF</Typography.Title><Typography.Text type="secondary">Extracts PDF text, layout, and images before quiz generation.</Typography.Text></div>
            {statusTag(Boolean(status?.marker.installed), Boolean(markerWorking), status?.marker.managed ? 'Installed by Quizzer' : 'Installed')}
          </div>
          <Button icon={<CloudDownloadOutlined />} loading={markerWorking} disabled={status?.marker.installed} onClick={() => void installMarker()}>
            {status?.marker.installed ? 'Marker ready' : 'Install Marker'}
          </Button>
          {status?.marker.job.message && status.marker.job.state !== 'idle' && (
            <Alert showIcon type={status.marker.job.state === 'error' ? 'error' : status.marker.job.state === 'complete' ? 'success' : 'info'}
              message={status.marker.job.state === 'working' ? 'Installing Marker' : status.marker.job.state === 'complete' ? 'Marker ready' : 'Installation failed'}
              description={<pre className="plugin-output">{status.marker.job.message}</pre>} />
          )}
        </section>

        <section className="plugin-card">
          <div className="plugin-card-heading">
            <div><Typography.Title level={5}>Codex Agent</Typography.Title><Typography.Text type="secondary">Uses the Codex CLI and your ChatGPT sign-in. No API key is required.</Typography.Text></div>
            {statusTag(Boolean(status?.codex.connected), Boolean(codexWorking), 'Connected')}
          </div>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input value={codexModel} onChange={event => setCodexModel(event.target.value)} addonBefore="Default model" placeholder="Use the Codex default" />
            <Button icon={<LoginOutlined />} loading={codexWorking} disabled={!status?.codex.installed || status?.codex.connected} onClick={() => void connectCodex()}>
              {!status?.codex.installed ? 'Codex CLI not found' : status.codex.connected ? 'Codex connected' : 'Connect Codex'}
            </Button>
            {loginUrl && codexWorking && <Typography.Link href={loginUrl} target="_blank" rel="noreferrer">Open the Codex sign-in page</Typography.Link>}
            {status?.codex.job.message && status.codex.job.state !== 'idle' && <pre className="plugin-output">{status.codex.job.message}</pre>}
          </Space>
        </section>

        <section className="plugin-card">
          <div className="plugin-card-heading">
            <div><Typography.Title level={5}>Gemini API</Typography.Title><Typography.Text type="secondary">Uses your Gemini API key, kept only in this browser tab.</Typography.Text></div>
            {statusTag(Boolean(geminiKey.trim()), false, 'Connected')}
          </div>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.Password value={geminiKey} onChange={event => setGeminiKeyState(event.target.value)} placeholder="Gemini API key" autoComplete="off" />
            <Input value={geminiModel} onChange={event => setGeminiModel(event.target.value)} addonBefore="Default model" placeholder="gemini-2.5-flash" />
          </Space>
        </section>

        <Divider style={{ margin: '4px 0' }} />
        <div>
          <Typography.Text strong>Default generation provider</Typography.Text>
          <Radio.Group value={defaultProvider} onChange={event => setDefaultProvider(event.target.value)} style={{ display: 'flex', marginTop: 8 }}
            options={[{ label: 'Codex Agent', value: 'codex' }, { label: 'Gemini API', value: 'gemini' }]} />
        </div>
      </Space>}
    </Modal>
  );
}
