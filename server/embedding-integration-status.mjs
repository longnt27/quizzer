import { isLoopbackEmbeddingEndpoint } from './embeddings.mjs';
import { effectiveEmbeddingModel, effectiveEmbeddingProvider } from './plugin-embeddings.mjs';
import { ollamaModelMatches } from './ollama-generation.mjs';

const asCredentialSet = providers => new Set(Array.isArray(providers) ? providers : []);
const withEnabledState = (enabled, status) => enabled ? status : 'disabled';

export const describeEmbeddingIntegration = ({
  settings,
  ollama = { serverReady: false, models: [] },
  ollamaInstalled = false,
  credentialProviders = [],
  job,
}) => {
  const values = settings?.values ?? {};
  const provider = effectiveEmbeddingProvider(settings);
  const model = effectiveEmbeddingModel(settings, provider);
  const enabled = values['embeddings.enabled'] !== false;
  const credentials = asCredentialSet(credentialProviders);

  if (provider === 'ollama') {
    const installed = (ollama.models ?? []).some(item => ollamaModelMatches(item.name, model));
    const runtimeInstalled = Boolean(ollamaInstalled || ollama.serverReady);
    const status = installed ? 'ready' : runtimeInstalled ? 'model-missing' : 'runtime-missing';
    return {
      provider,
      model,
      privacy: 'local',
      installable: true,
      installed,
      runtimeInstalled,
      credentialConfigured: true,
      status: withEnabledState(enabled, status),
      job,
    };
  }

  if (provider === 'openai-compatible') {
    const endpoint = typeof values['embeddings.openaiCompatible.endpoint'] === 'string'
      ? values['embeddings.openaiCompatible.endpoint'].trim()
      : 'http://127.0.0.1:8080/v1';
    const local = isLoopbackEmbeddingEndpoint(endpoint || 'http://127.0.0.1:8080/v1');
    const credentialConfigured = local || credentials.has('openai-compatible');
    const remoteAllowed = local || values['embeddings.allowRemote'] === true;
    const status = !remoteAllowed
      ? 'remote-permission-required'
      : !credentialConfigured
        ? 'credential-required'
        : 'ready';
    return {
      provider,
      model,
      privacy: local ? 'local' : 'remote-api',
      installable: false,
      credentialConfigured,
      status: withEnabledState(enabled, status),
      job,
    };
  }

  if (provider === 'openai' || provider === 'gemini') {
    const credentialConfigured = credentials.has(provider);
    const remoteAllowed = values['embeddings.allowRemote'] === true;
    const status = !remoteAllowed
      ? 'remote-permission-required'
      : !credentialConfigured
        ? 'credential-required'
        : 'ready';
    return {
      provider,
      model,
      privacy: 'remote-api',
      installable: false,
      credentialConfigured,
      status: withEnabledState(enabled, status),
      job,
    };
  }

  const component = typeof values['embeddings.embedderPlugin'] === 'string'
    ? values['embeddings.embedderPlugin'].trim()
    : '';
  return {
    provider: 'plugin',
    model,
    privacy: 'local',
    installable: false,
    credentialConfigured: true,
    status: withEnabledState(enabled, component && component !== 'builtin' ? 'configured' : 'plugin-required'),
    job,
  };
};
