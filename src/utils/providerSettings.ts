import type { GenerationProvider, ProviderRoute } from '../types';
import { serviceJson } from './serviceApi';
import { getKnownProviderRouteMetadata } from './providerPricing';

const PROVIDER_SETTINGS_KEY = 'quizzer.providerSettings';
const API_KEY_PREFIX = 'quizzer.apiKey.';
let rememberedApiKeys: Partial<Record<GenerationProvider, string>> = {};

export type ProviderKind = 'agent' | 'api' | 'local' | 'plugin';
export type AgentProvider = 'codex' | 'claude-agent' | 'antigravity-agent';
export type ApiProvider = Exclude<GenerationProvider, AgentProvider | 'ollama' | 'plugin'>;

export interface ProviderDefinition {
  id: GenerationProvider;
  label: string;
  kind: ProviderKind;
  description: string;
  defaultModel: string;
  keyLabel?: string;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  { id: 'plugin', label: 'Local generator – Plugin', kind: 'plugin', description: 'Runs an installed generator plugin out of process on this device.', defaultModel: '' },
  { id: 'ollama', label: 'Ollama – Local', kind: 'local', description: 'Runs an installed Ollama model entirely on this device.', defaultModel: '' },
  { id: 'codex', label: 'Codex – Agent', kind: 'agent', description: 'Uses the Codex CLI and your ChatGPT sign-in.', defaultModel: '' },
  { id: 'claude-agent', label: 'Claude – Agent', kind: 'agent', description: 'Uses the Claude Code CLI and its signed-in account.', defaultModel: '' },
  { id: 'antigravity-agent', label: 'Antigravity – Agent', kind: 'agent', description: 'Uses the Antigravity CLI and its signed-in account.', defaultModel: '' },
  { id: 'gemini', label: 'Gemini – API', kind: 'api', description: 'Calls Google Gemini with your API key.', defaultModel: 'gemini-2.5-flash', keyLabel: 'Gemini API key' },
  { id: 'anthropic', label: 'Claude – API', kind: 'api', description: 'Calls the native Anthropic Messages API.', defaultModel: 'claude-sonnet-4-5-20250929', keyLabel: 'Anthropic API key' },
  { id: 'openai', label: 'OpenAI – API', kind: 'api', description: 'Calls the OpenAI Responses API.', defaultModel: 'gpt-5-mini', keyLabel: 'OpenAI API key' },
  { id: 'openrouter', label: 'OpenRouter – API', kind: 'api', description: 'Uses an OpenRouter model through its unified API.', defaultModel: 'openai/gpt-4o-mini', keyLabel: 'OpenRouter API key' },
  { id: 'deepseek', label: 'DeepSeek – API', kind: 'api', description: 'Calls DeepSeek through its OpenAI-compatible API.', defaultModel: 'deepseek-v4-flash', keyLabel: 'DeepSeek API key' },
  { id: 'openai-compatible', label: 'OpenAI-compatible – Custom', kind: 'api', description: 'Calls a custom OpenAI-compatible chat completions endpoint.', defaultModel: '', keyLabel: 'OpenAI-compatible API key (optional for loopback)' },
] as const;

export const API_PROVIDERS = PROVIDERS.filter(provider => provider.kind === 'api') as readonly (ProviderDefinition & { id: ApiProvider })[];
export const AGENT_PROVIDERS = PROVIDERS.filter(provider => provider.kind === 'agent') as readonly (ProviderDefinition & { id: AgentProvider })[];
export const getProviderDefinition = (id: GenerationProvider) => PROVIDERS.find(provider => provider.id === id) ?? PROVIDERS[0];

export const isOpenAILoopbackEndpoint = (endpoint?: string) => {
  if (!endpoint || typeof endpoint !== 'string') return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
  } catch {
    return false;
  }
};

export const ollamaModelMatches = (installed: string, configured: string) => installed === configured
  || (!configured.includes(':') && installed === `${configured}:latest`)
  || (!installed.includes(':') && configured === `${installed}:latest`);

export const getProviderRoute = (provider: GenerationProvider, model?: string, approved = false): ProviderRoute => {
  const definition = getProviderDefinition(provider);
  return {
    provider,
    model: model?.trim() || undefined,
    privacy: definition.kind === 'plugin' || definition.kind === 'local' ? 'local' : definition.kind === 'agent' ? 'signed-in-agent' : 'remote-api',
    paid: definition.kind === 'api',
    approved,
    ...getKnownProviderRouteMetadata(provider, model?.trim() || undefined),
  };
};

export interface ProviderSettings {
  defaultProvider: GenerationProvider;
  models: Record<GenerationProvider, string>;
  enabledProviders: Record<GenerationProvider, boolean>;
  enabledTools: { marker: boolean; ocr: boolean; embeddings: boolean };
}

const defaultModels = Object.fromEntries(PROVIDERS.map(provider => [provider.id, provider.defaultModel])) as Record<GenerationProvider, string>;
const defaultEnabledProviders = Object.fromEntries(PROVIDERS.map(provider => [provider.id, true])) as Record<GenerationProvider, boolean>;
const defaultEnabledTools = { marker: true, ocr: true, embeddings: true };
const defaults: ProviderSettings = {
  defaultProvider: 'codex', models: defaultModels, enabledProviders: defaultEnabledProviders, enabledTools: defaultEnabledTools,
};

export const getProviderSettings = (): ProviderSettings => {
  try {
    const stored = JSON.parse(localStorage.getItem(PROVIDER_SETTINGS_KEY) ?? '{}') as Partial<ProviderSettings> & {
      codexModel?: string;
      geminiModel?: string;
    };
    const defaultProvider = PROVIDERS.some(provider => provider.id === stored.defaultProvider) ? stored.defaultProvider! : defaults.defaultProvider;
    return {
      defaultProvider,
      models: {
        ...defaultModels,
        ...(stored.models ?? {}),
        ...(stored.codexModel !== undefined ? { codex: stored.codexModel } : {}),
        ...(stored.geminiModel !== undefined ? { gemini: stored.geminiModel } : {}),
      },
      enabledProviders: { ...defaultEnabledProviders, ...(stored.enabledProviders ?? {}) },
      enabledTools: { ...defaultEnabledTools, ...(stored.enabledTools ?? {}) },
    };
  } catch {
    return defaults;
  }
};

export const setProviderSettings = (settings: ProviderSettings) => {
  localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event('quizzer:provider-settings'));
};

export const getApiKey = (provider: GenerationProvider) => sessionStorage.getItem(`${API_KEY_PREFIX}${provider}`) ?? rememberedApiKeys[provider] ?? '';

export const syncProviderCredentials = async () => {
  const values = Object.fromEntries(API_PROVIDERS.flatMap(({ id }) => {
    const value = getApiKey(id);
    return value ? [[id, value]] : [];
  }));
  return serviceJson<{ providers: GenerationProvider[] }>('/api/v1/provider-credentials', 'PUT', { values });
};

export const setApiKey = (provider: GenerationProvider, value: string) => {
  const key = `${API_KEY_PREFIX}${provider}`;
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
  void syncProviderCredentials().catch(() => {});
};

export const loadRememberedApiKeys = async () => {
  if (!window.quizzerDesktop) return { values: rememberedApiKeys, providers: [] as GenerationProvider[] };
  const values = await window.quizzerDesktop.credentials.list();
  rememberedApiKeys = { ...values };
  await syncProviderCredentials();
  window.dispatchEvent(new Event('quizzer:provider-settings'));
  return { values: rememberedApiKeys, providers: Object.keys(values) as GenerationProvider[] };
};

export const rememberApiKey = async (provider: GenerationProvider, value: string) => {
  if (!window.quizzerDesktop) throw new Error('Remembered credentials are available only in the desktop app');
  await window.quizzerDesktop.credentials.set(provider, value);
  rememberedApiKeys = { ...rememberedApiKeys, [provider]: value.trim() };
};

export const forgetRememberedApiKey = async (provider: GenerationProvider) => {
  if (window.quizzerDesktop) await window.quizzerDesktop.credentials.delete(provider);
  const next = { ...rememberedApiKeys };
  delete next[provider];
  rememberedApiKeys = next;
};

// Retain the old Gemini key for users upgrading from earlier Quizzer builds.
export const migrateLegacyGeminiKey = () => {
  const legacy = sessionStorage.getItem('quizzer.geminiApiKey');
  if (legacy && !getApiKey('gemini')) setApiKey('gemini', legacy);
  if (legacy) sessionStorage.removeItem('quizzer.geminiApiKey');
};

export const getGeminiApiKey = () => getApiKey('gemini');
export const setGeminiApiKey = (value: string) => setApiKey('gemini', value);
