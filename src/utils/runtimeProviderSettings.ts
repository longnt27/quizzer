import type { GenerationProvider } from '../types';
import { PROVIDERS, type ProviderSettings } from './providerSettings.ts';

type ResolvedValue = string | number | boolean;

export const resolveRendererProviderSettings = (
  current: ProviderSettings,
  values: Record<string, ResolvedValue | undefined>,
): ProviderSettings => {
  const defaultProvider = values['generation.defaultProvider'];
  const nextProvider = typeof defaultProvider === 'string' && PROVIDERS.some(provider => provider.id === defaultProvider)
    ? defaultProvider as GenerationProvider
    : current.defaultProvider;
  const nextTools = {
    marker: Boolean(values['extraction.marker']),
    ocr: Boolean(values['extraction.ocr']),
    embeddings: Boolean(values['embeddings.enabled']),
  };
  const toolsChanged = Object.entries(nextTools).some(([key, value]) => current.enabledTools[key as keyof typeof nextTools] !== value);
  const serviceLlamaModel = values['providers.llama-cpp.model'];
  const resolvedLlamaModel = typeof serviceLlamaModel === 'string' ? serviceLlamaModel.trim() : '';
  const modelChanged = Boolean(resolvedLlamaModel) && current.models['llama-cpp'] !== resolvedLlamaModel;
  if (current.defaultProvider === nextProvider && !toolsChanged && !modelChanged) return current;
  return {
    ...current,
    defaultProvider: nextProvider,
    models: modelChanged ? { ...current.models, 'llama-cpp': resolvedLlamaModel } : current.models,
    enabledTools: toolsChanged ? nextTools : current.enabledTools,
  };
};
