import { useEffect, useState } from 'react';
import type { GenerationProvider } from '../types';
import { getApiKey, getProviderSettings, PROVIDERS, type AgentProvider, type ProviderDefinition } from './providerSettings';
import { serviceFetch } from './serviceApi';

interface IntegrationStatus {
  codex?: { connected?: boolean };
  'claude-agent'?: { connected?: boolean };
  'antigravity-agent'?: { connected?: boolean };
}

interface PluginCollection {
  plugins?: Array<{ id: string; status?: string; enabled?: boolean; compatible?: boolean; capabilities?: string[] }>;
}

const localApiProviders = () => PROVIDERS.filter(provider => provider.kind === 'api' && Boolean(getApiKey(provider.id).trim()));

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
        }
      } catch { /* API providers remain usable if the status check is temporarily unavailable. */ }
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
