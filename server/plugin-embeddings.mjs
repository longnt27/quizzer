import { embedTextsWithOllama } from './embeddings.mjs';

const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MAX_TEXT_LENGTH = 100_000;
const MAX_TOTAL_TEXT_LENGTH = 2_000_000;
const MAX_DIMENSIONS = 8_192;

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

export const resolveEmbeddingProvider = async (settings, {
  loadManager,
  builtin = embedTextsWithOllama,
} = {}) => {
  const component = settings?.values?.['embeddings.embedderPlugin'] ?? 'builtin';
  const model = settings?.values?.['embeddings.model'];
  if (component === 'builtin') return {
    component,
    identity: model,
    embed: (texts, { signal } = {}) => builtin(texts, { model, signal }),
  };
  if (!pluginIdPattern.test(component) || typeof loadManager !== 'function') {
    throw unavailable(`Embedder plugin ${component} is not configured correctly`);
  }
  const manager = await loadManager();
  const plugin = (await manager.list()).find(item => item.id === component);
  const ready = Boolean(plugin && plugin.status === 'installed' && plugin.enabled && plugin.compatible
    && plugin.capabilities?.includes('embedder'));
  const identity = `plugin:${component}@${plugin?.version ?? 'unavailable'}:${model}`;
  return {
    component,
    identity,
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
