import { useEffect, useState } from 'react';
import type { GenerationProvider } from '../types';
import {
  getApiKey, getProviderSettings, isOpenAILoopbackEndpoint, ollamaModelMatches, PROVIDERS,
  type AgentProvider, type ProviderDefinition,
} from './providerSettings';
import { serviceFetch } from './serviceApi';

interface IntegrationStatus {
  codex?: { connected?: boolean };
  'claude-agent'?: { connected?: boolean };
  'antigravity-agent'?: { connected?: boolean };
  ollama?: { serverReady?: boolean; models?: Array<{ name?: string }> };
  'llama-cpp'?: { configured?: boolean; serverReady?: boolean; models?: Array<{ id?: string }> };
}

interface PluginCollection {
  plugins?: Array<{ id: string; status?: string; enabled?: boolean; compatible?: boolean; capabilities?: string[] }>;
}

const localApiProviders = () => PROVIDERS.filter(provider => {
  if (provider.id === 'openai-compatible') {
    return Boolean(getApiKey('openai-compatible').trim()) && Boolean(getProviderSettings().models['openai-compatible']?.trim());
  }
  return provider.kind === 'api' && Boolean(getApiKey(provider.id).trim());
});

export const useConfiguredProviders = () => {
  const [providers, setProviders] = useState<ProviderDefinition[]>(localApiProviders);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const settings = getProviderSettings();
      const available = new Set<GenerationProvider>(localApiProviders().map(provider => provider.id));
      try {
        const response = await serviceFetch('/api/integrations');
        const status = await response.json() as IntegrationStatus;
        if (response.ok) {
          for (const provider of PROVIDERS) {
            if (provider.kind === 'agent' && status[provider.id as AgentProvider]?.connected) available.add(provider.id);
          }
          if (status.ollama?.serverReady && status.ollama.models?.some(model => model.name
            && ollamaModelMatches(model.name, settings.models.ollama))) available.add('ollama');
          if (status['llama-cpp']?.serverReady && (!status['llama-cpp'].models?.length
            || status['llama-cpp'].models.some(model => model.id === settings.models['llama-cpp']))) {
            available.add('llama-cpp');
          }
        }
      } catch { /* API providers remain usable if the status check is temporarily unavailable. */ }
      try {
        const [settingsRes, credsRes] = await Promise.all([
          serviceFetch('/api/v1/settings'),
          serviceFetch('/api/v1/provider-credentials'),
        ]);
        if (settingsRes.ok) {
          const settingsPayload = await settingsRes.json() as { values?: Record<string, unknown> };
          const endpoint = typeof settingsPayload?.values?.['providers.openai-compatible.endpoint'] === 'string'
            ? settingsPayload.values['providers.openai-compatible.endpoint']
            : undefined;
          const credsPayload = credsRes.ok ? await credsRes.json() as { providers?: string[] } : null;
          const hasServiceKey = Boolean(credsPayload?.providers?.includes('openai-compatible'));
          const hasLocalKey = Boolean(getApiKey('openai-compatible').trim());
          const hasModel = Boolean(settings.models['openai-compatible']?.trim());
          if (hasModel && (hasLocalKey || hasServiceKey || isOpenAILoopbackEndpoint(endpoint))) {
            available.add('openai-compatible');
          }
        }
      } catch { /* If settings check fails, localApiProviders handles remembered keys */ }
      try {
        const response = await serviceFetch('/api/v1/plugins');
        const collection = await response.json() as PluginCollection;
        const selected = settings.models.plugin;
        if (response.ok && collection.plugins?.some(plugin => plugin.id === selected && plugin.status === 'installed'
          && plugin.enabled && plugin.compatible && plugin.capabilities?.includes('generator'))) available.add('plugin');
      } catch { /* Other configured routes remain available if plugin discovery fails. */ }
      if (active) {
        setProviders(PROVIDERS.filter(provider => available.has(provider.id) && settings.enabledProviders[provider.id]) as ProviderDefinition[]);
        setLoading(false);
      }
    };
    void refresh();
    window.addEventListener('quizzer:provider-settings', refresh);
    return () => { active = false; window.removeEventListener('quizzer:provider-settings', refresh); };
  }, []);

  return { providers, loading };
};
