import { createHash } from 'node:crypto';
import {
  embedTextsWithGemini,
  embedTextsWithOllama,
  embedTextsWithOpenAI,
  embedTextsWithOpenAICompatible,
  isLoopbackEmbeddingEndpoint,
  validateOpenAIEmbeddingEndpoint,
} from './embeddings.mjs';
import { getProviderCredential } from './provider-credentials.mjs';

const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MAX_TEXT_LENGTH = 100_000;
const MAX_TOTAL_TEXT_LENGTH = 2_000_000;
const MAX_DIMENSIONS = 8_192;
const DEFAULT_OPENAI_COMPATIBLE_ENDPOINT = 'http://127.0.0.1:8080/v1';
const DEFAULT_GEMINI_DIMENSIONS = 768;
const supportedProviders = new Set(['ollama', 'openai-compatible', 'openai', 'gemini', 'plugin']);
const defaultCloudModels = Object.freeze({
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-2',
});

const validateTexts = texts => {
  if (!Array.isArray(texts) || !texts.length || texts.length > 250
    || texts.some(text => typeof text !== 'string' || text.length > MAX_TEXT_LENGTH)
    || texts.reduce((total, text) => total + text.length, 0) > MAX_TOTAL_TEXT_LENGTH) {
    throw new Error('Plugin embedding input must contain 1-250 bounded strings');
  }
  return texts;
};

export const validatePluginEmbeddings = (embeddings, expectedCount) => {
  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount || !embeddings.length) {
    throw new Error('Embedder plugin returned the wrong number of vectors');
  }
  const dimensions = embeddings[0]?.length;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS
    || embeddings.some(vector => !Array.isArray(vector) || vector.length !== dimensions
      || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new Error('Embedder plugin returned invalid or inconsistent vectors');
  }
  return embeddings;
};

const unavailable = message => Object.assign(new Error(message), { code: 'provider_unavailable' });
const endpointHash = endpoint => createHash('sha256').update(endpoint).digest('hex').slice(0, 12);
export const effectiveEmbeddingProvider = settings => {
  const values = settings?.values ?? {};
  const configured = values['embeddings.provider'];
  if (configured !== undefined) {
    if (!supportedProviders.has(configured)) throw unavailable(`Embedding provider ${configured} is not supported`);
    return configured;
  }
  return values['embeddings.embedderPlugin'] && values['embeddings.embedderPlugin'] !== 'builtin' ? 'plugin' : 'ollama';
};

export const effectiveEmbeddingModel = (settings, provider = effectiveEmbeddingProvider(settings)) => {
  const values = settings?.values ?? {};
  const configuredModel = values['embeddings.model'];
  if (typeof configuredModel !== 'string' || !configuredModel.trim()) throw unavailable('Embedding model is not configured');
  const modelSource = settings?.sources?.['embeddings.model'];
  const modelIsProfileDefault = modelSource === 'default' || modelSource?.startsWith('profile:');
  return modelIsProfileDefault && defaultCloudModels[provider]
    ? defaultCloudModels[provider]
    : configuredModel.trim();
};

export const resolveEmbeddingProvider = async (settings, {
  loadManager,
  getCredential = getProviderCredential,
  ollama = embedTextsWithOllama,
  openAICompatible = embedTextsWithOpenAICompatible,
  openai = embedTextsWithOpenAI,
  gemini = embedTextsWithGemini,
} = {}) => {
  const values = settings?.values ?? {};
  const provider = effectiveEmbeddingProvider(settings);
  const model = effectiveEmbeddingModel(settings, provider);
  const allowRemote = values['embeddings.allowRemote'] === true;

  if (provider === 'ollama') return {
    component: 'ollama',
    identity: `ollama:${model}`,
    privacy: 'local',
    embed: (texts, { signal } = {}) => ollama(texts, { model, signal }),
  };

  if (provider === 'openai') {
    return {
      component: 'openai',
      identity: `openai:${model}`,
      privacy: 'remote-api',
      embed: async (texts, { signal } = {}) => {
        if (!allowRemote) throw unavailable('Remote embeddings are disabled; enable remote embeddings explicitly before sending content');
        const apiKey = getCredential?.('openai');
        if (!apiKey) throw unavailable('OpenAI embedding credential is not configured');
        return openai(texts, { model, apiKey, signal });
      },
    };
  }

  if (provider === 'gemini') {
    return {
      component: 'gemini',
      identity: `gemini:${model}:${DEFAULT_GEMINI_DIMENSIONS}:retrieval-v1`,
      privacy: 'remote-api',
      embed: async (texts, { purpose = 'document', signal } = {}) => {
        if (!allowRemote) throw unavailable('Remote embeddings are disabled; enable remote embeddings explicitly before sending content');
        const apiKey = getCredential?.('gemini');
        if (!apiKey) throw unavailable('Gemini embedding credential is not configured');
        return gemini(texts, {
          model, apiKey, outputDimensionality: DEFAULT_GEMINI_DIMENSIONS, purpose, signal,
        });
      },
    };
  }

  if (provider === 'openai-compatible') {
    const endpoint = validateOpenAIEmbeddingEndpoint(values['embeddings.openaiCompatible.endpoint'] || DEFAULT_OPENAI_COMPATIBLE_ENDPOINT);
    const local = isLoopbackEmbeddingEndpoint(endpoint);
    return {
      component: 'openai-compatible',
      identity: `openai-compatible:${endpointHash(endpoint)}:${model}`,
      privacy: local ? 'local' : 'remote-api',
      embed: async (texts, { signal } = {}) => {
        if (!local && !allowRemote) throw unavailable('Remote embeddings are disabled; enable remote embeddings explicitly before sending content');
        const apiKey = getCredential?.('openai-compatible');
        if (!local && !apiKey) throw unavailable('OpenAI-compatible embedding credential is not configured for this remote endpoint');
        return openAICompatible(texts, { model, endpoint, apiKey, signal });
      },
    };
  }

  const component = values['embeddings.embedderPlugin'] ?? 'builtin';
  if (!pluginIdPattern.test(component) || component === 'builtin' || typeof loadManager !== 'function') {
    throw unavailable(`Embedder plugin ${component} is not configured correctly`);
  }
  const manager = await loadManager();
  const plugin = (await manager.list()).find(item => item.id === component);
  const ready = Boolean(plugin && plugin.status === 'installed' && plugin.enabled && plugin.compatible
    && plugin.capabilities?.includes('embedder'));
  const identity = `plugin:${component}@${plugin?.version ?? 'unavailable'}:${model}`;
  return {
    component: 'plugin',
    identity,
    privacy: 'local',
    embed: async (texts, { signal } = {}) => {
      validateTexts(texts);
      if (!ready) throw unavailable(`Embedder plugin ${component} is not installed, enabled, and compatible`);
      let invocation;
      try {
        invocation = await manager.invoke(component, 'rag.embed', { texts, model }, { signal, timeoutMs: 5 * 60_000 });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        throw unavailable(`Embedder plugin ${component} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return validatePluginEmbeddings(invocation?.result?.embeddings, texts.length);
    },
  };
};
