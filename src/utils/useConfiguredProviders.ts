import { useEffect, useState } from 'react';
import type { GenerationProvider } from '../types';
import { getApiKey, PROVIDERS, type AgentProvider, type ProviderDefinition } from './providerSettings';

interface IntegrationStatus {
  codex?: { connected?: boolean };
  'claude-agent'?: { connected?: boolean };
  'antigravity-agent'?: { connected?: boolean };
}

const localApiProviders = () => PROVIDERS.filter(provider => provider.kind === 'api' && Boolean(getApiKey(provider.id).trim()));

export const useConfiguredProviders = () => {
  const [providers, setProviders] = useState<ProviderDefinition[]>(localApiProviders);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const available = new Set<GenerationProvider>(localApiProviders().map(provider => provider.id));
      try {
        const response = await fetch('/api/integrations');
        const status = await response.json() as IntegrationStatus;
        if (response.ok) {
          for (const provider of PROVIDERS) {
            if (provider.kind === 'agent' && status[provider.id as AgentProvider]?.connected) available.add(provider.id);
          }
        }
      } catch { /* API providers remain usable if the status check is temporarily unavailable. */ }
      if (active) {
        setProviders(PROVIDERS.filter(provider => available.has(provider.id)) as ProviderDefinition[]);
        setLoading(false);
      }
    };
    void refresh();
    window.addEventListener('quizzer:provider-settings', refresh);
    return () => { active = false; window.removeEventListener('quizzer:provider-settings', refresh); };
  }, []);

  return { providers, loading };
};
