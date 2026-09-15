import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Space, Switch, Typography } from 'antd';
import { ApiOutlined, CloudDownloadOutlined, DesktopOutlined, GoogleOutlined, OpenAIOutlined } from '@ant-design/icons';
import { formatErrorMessage } from '../utils/errorFormatting';
import { getMessageApi } from '../utils/messageProvider';
import { getModalApi } from '../utils/modalProvider';
import { ollamaModelMatches } from '../utils/providerSettings';
import { serviceJson, serviceRequest } from '../utils/serviceApi';

type EmbeddingProvider = 'ollama' | 'openai-compatible' | 'openai' | 'gemini' | 'plugin';
type JobState = 'idle' | 'working' | 'complete' | 'error';

interface SettingsResponse {
  values: Record<string, unknown>;
}

interface CredentialStatus {
  providers: string[];
}

interface IntegrationStatus {
  ollama?: { models?: Array<{ name: string }> };
  embeddings?: { job?: { state: JobState; message: string } };
}

interface ProviderDefinition {
  id: Exclude<EmbeddingProvider, 'plugin'>;
  title: string;
  icon: ReactNode;
  description: string;
  defaultModel: (values: Record<string, unknown>) => string;
}

const providerDefinitions: ProviderDefinition[] = [
  {
    id: 'ollama',
    title: 'Ollama embeddings',
    icon: <DesktopOutlined />,
    description: 'Local embeddings through Ollama. Model downloads stay on this device.',
    defaultModel: values => values['hardware.profile'] === 'max' ? 'bge-m3' : 'all-minilm',
  },
  {
    id: 'openai-compatible',
    title: 'OpenAI-compatible embeddings',
    icon: <ApiOutlined />,
    description: 'Local or custom /v1/embeddings endpoint. Configure the endpoint and model in Settings → Retrieval.',
    defaultModel: () => 'all-minilm',
  },
  {
    id: 'openai',
    title: 'OpenAI embeddings',
    icon: <OpenAIOutlined />,
    description: 'Cloud embeddings using the existing OpenAI API credential.',
    defaultModel: () => 'text-embedding-3-small',
  },
  {
    id: 'gemini',
    title: 'Gemini embeddings',
    icon: <GoogleOutlined />,
    description: 'Cloud embeddings using the existing Gemini API credential and retrieval-specific formatting.',
    defaultModel: () => 'gemini-embedding-2',
  },
];

const isLoopbackCompatibleEndpoint = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const octets = host.split('.');
    const loopback = host === 'localhost' || host === '::1'
      || (octets.length === 4 && octets[0] === '127'
        && octets.slice(1).every(value => /^\d{1,3}$/.test(value) && Number(value) <= 255));
    return url.protocol === 'http:' && loopback;
  } catch {
    return false;
  }
};

const providerIsRemote = (provider: Exclude<EmbeddingProvider, 'plugin'>, values: Record<string, unknown>) => {
  if (provider === 'openai' || provider === 'gemini') return true;
  if (provider !== 'openai-compatible') return false;
  const endpoint = typeof values['embeddings.openaiCompatible.endpoint'] === 'string'
    ? values['embeddings.openaiCompatible.endpoint']
    : 'http://127.0.0.1:8080/v1';
  return !isLoopbackCompatibleEndpoint(endpoint);
};

const currentProvider = (values: Record<string, unknown>): EmbeddingProvider => {
  const plugin = values['embeddings.embedderPlugin'];
  if (typeof plugin === 'string' && plugin !== 'builtin') return 'plugin';
  const provider = values['embeddings.provider'];
  return providerDefinitions.some(item => item.id === provider) ? provider as EmbeddingProvider : 'ollama';
};

export default function EmbeddingProviderOptions() {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [credentials, setCredentials] = useState<Set<string>>(new Set());
  const [integrations, setIntegrations] = useState<IntegrationStatus>({});
  const [busy, setBusy] = useState('');
  const message = getMessageApi();

  const refresh = useCallback(async () => {
    try {
      const [settings, credentialStatus, status] = await Promise.all([
        serviceRequest<SettingsResponse>('/api/v1/settings'),
        serviceRequest<CredentialStatus>('/api/v1/provider-credentials').catch(() => ({ providers: [] })),
        serviceRequest<IntegrationStatus>('/api/integrations').catch(() => ({})),
      ]);
      setValues(settings.values ?? {});
      setCredentials(new Set(credentialStatus.providers ?? []));
      setIntegrations(status);
    } catch (error) {
      message.error(formatErrorMessage(error, 'embedding'));
    }
  }, [message]);

  useEffect(() => {
    void refresh();
    const onSettingsChanged = () => void refresh();
    window.addEventListener('quizzer:settings-changed', onSettingsChanged);
    return () => window.removeEventListener('quizzer:settings-changed', onSettingsChanged);
  }, [refresh]);

  useEffect(() => {
    if (integrations.embeddings?.job?.state !== 'working') return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [integrations.embeddings?.job?.state, refresh]);

  const activeProvider = currentProvider(values);
  const enabled = values['embeddings.enabled'] === true;
  const allowRemote = values['embeddings.allowRemote'] === true;
  const selectedModel = typeof values['embeddings.model'] === 'string' ? values['embeddings.model'] : '';
  const ollamaDefault = useMemo(() => providerDefinitions[0].defaultModel(values), [values]);
  const ollamaModel = activeProvider === 'ollama' && selectedModel ? selectedModel : ollamaDefault;
  const ollamaInstalled = Boolean(integrations.ollama?.models?.some(model => ollamaModelMatches(model.name, ollamaModel)));

  const patch = async (next: Record<string, unknown>) => {
    const response = await serviceJson<SettingsResponse>('/api/v1/settings', 'PATCH', { values: next });
    setValues(response.values ?? { ...values, ...next });
    window.dispatchEvent(new Event('quizzer:settings-changed'));
  };

  const activate = async (provider: Exclude<EmbeddingProvider, 'plugin'>, permitRemote = false) => {
    setBusy(provider);
    try {
      const definition = providerDefinitions.find(item => item.id === provider)!;
      const sameProvider = activeProvider === provider;
      const model = sameProvider && selectedModel ? selectedModel : definition.defaultModel(values);
      await patch({
        'embeddings.provider': provider,
        'embeddings.enabled': true,
        'embeddings.embedderPlugin': 'builtin',
        'embeddings.model': model,
        ...(permitRemote ? { 'embeddings.allowRemote': true } : {}),
      });
    } catch (error) {
      message.error(formatErrorMessage(error, 'embedding'));
    } finally {
      setBusy('');
    }
  };

  const toggleProvider = (provider: Exclude<EmbeddingProvider, 'plugin'>, checked: boolean) => {
    if (!checked) {
      if (activeProvider !== provider) return;
      setBusy(provider);
      void patch({ 'embeddings.enabled': false }).catch(error => {
        message.error(formatErrorMessage(error, 'embedding'));
      }).finally(() => setBusy(''));
      return;
    }

    const remote = providerIsRemote(provider, values);
    if (remote && !allowRemote) {
      const definition = providerDefinitions.find(item => item.id === provider)!;
      getModalApi().confirm({
        title: `Use ${definition.title}?`,
        content: 'Document chunks and search queries will be sent to this remote provider. API usage may be billed. Quizzer will not silently fail over to another embedding provider.',
        okText: 'Allow remote embeddings',
        onOk: () => activate(provider, true),
      });
      return;
    }
    void activate(provider);
  };

  const installOllamaModel = () => {
    getModalApi().confirm({
      title: `Download ${ollamaModel}?`,
      content: 'Quizzer will ask the local Ollama runtime to download this embedding model. The download size depends on the model.',
      okText: 'Download model',
      onOk: async () => {
        setBusy('ollama-install');
        try {
          await serviceJson('/api/integrations/embeddings/install', 'POST', { model: ollamaModel, confirmed: true });
          await refresh();
        } catch (error) {
          message.error(formatErrorMessage(error, 'embedding'));
        } finally {
          setBusy('');
        }
      },
    });
  };

  const providerState = (definition: ProviderDefinition) => {
    const selected = activeProvider === definition.id;
    const model = selected && selectedModel ? selectedModel : definition.defaultModel(values);
    if (definition.id === 'ollama') {
      const readiness = ollamaInstalled ? 'model installed' : 'model not installed';
      return `${selected ? (enabled ? 'Selected · enabled' : 'Selected · disabled') : 'Local'} · ${model} · ${readiness}`;
    }
    const remote = providerIsRemote(definition.id, values);
    const needsCredential = definition.id === 'openai' || definition.id === 'gemini'
      || (definition.id === 'openai-compatible' && remote);
    const credentialReady = !needsCredential || credentials.has(definition.id);
    const route = remote ? 'Remote API' : 'Local endpoint';
    const readiness = credentialReady ? model : `${model} · credentials required`;
    return selected ? `${enabled ? 'Selected · enabled' : 'Selected · disabled'} · ${route} · ${readiness}` : `${route} · ${readiness}`;
  };

  return <>
    {providerDefinitions.map(definition => {
      const selected = activeProvider === definition.id;
      const working = busy === definition.id || (definition.id === 'ollama' && integrations.embeddings?.job?.state === 'working');
      const actions = definition.id === 'ollama' && !ollamaInstalled && integrations.embeddings?.job?.state !== 'working'
        ? <Button size="small" type="primary" icon={<CloudDownloadOutlined />} loading={busy === 'ollama-install'} onClick={installOllamaModel}>Install</Button>
        : null;
      return (
        <section className="plugin-option" key={definition.id}>
          <div className="plugin-option-main">
            <span className="plugin-option-icon" aria-hidden="true">{definition.icon}</span>
            <div className="plugin-option-copy">
              <Typography.Text strong>{definition.title}</Typography.Text>
              <Typography.Text type="secondary">{definition.description}</Typography.Text>
              <Typography.Text className="plugin-option-state" type="secondary">{providerState(definition)}</Typography.Text>
            </div>
            <Space className="plugin-option-actions" size="small" wrap>
              {actions}
              <Switch
                checked={selected && enabled}
                disabled={working || busy === 'ollama-install'}
                onChange={checked => toggleProvider(definition.id, checked)}
                aria-label={`Use ${definition.title}`}
              />
            </Space>
          </div>
          {definition.id === 'ollama' && integrations.embeddings?.job?.message ? (
            <div className="plugin-option-details"><pre className="plugin-output">{integrations.embeddings.job.message}</pre></div>
          ) : null}
        </section>
      );
    })}
  </>;
}
