import type { GenerationProvider } from '../types';

const PROVIDER_SETTINGS_KEY = 'quizzer.providerSettings';
const API_KEY_PREFIX = 'quizzer.apiKey.';

export type ProviderKind = 'agent' | 'api';
export type AgentProvider = 'codex' | 'claude-agent' | 'antigravity-agent';
export type ApiProvider = Exclude<GenerationProvider, AgentProvider>;

export interface ProviderDefinition {
  id: GenerationProvider;
  label: string;
  kind: ProviderKind;
  description: string;
  defaultModel: string;
  keyLabel?: string;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  { id: 'codex', label: 'Codex – Agent', kind: 'agent', description: 'Uses the Codex CLI and your ChatGPT sign-in.', defaultModel: '' },
  { id: 'claude-agent', label: 'Claude – Agent', kind: 'agent', description: 'Uses the Claude Code CLI and its signed-in account.', defaultModel: '' },
  { id: 'antigravity-agent', label: 'Antigravity – Agent', kind: 'agent', description: 'Uses the Antigravity CLI and its signed-in account.', defaultModel: '' },
  { id: 'gemini', label: 'Gemini – API', kind: 'api', description: 'Calls Google Gemini with your API key.', defaultModel: 'gemini-2.5-flash', keyLabel: 'Gemini API key' },
  { id: 'anthropic', label: 'Claude – API', kind: 'api', description: 'Calls the native Anthropic Messages API.', defaultModel: 'claude-sonnet-4-5-20250929', keyLabel: 'Anthropic API key' },
  { id: 'openai', label: 'OpenAI – API', kind: 'api', description: 'Calls the OpenAI Responses API.', defaultModel: 'gpt-5-mini', keyLabel: 'OpenAI API key' },
  { id: 'openrouter', label: 'OpenRouter – API', kind: 'api', description: 'Uses an OpenRouter model through its unified API.', defaultModel: 'openai/gpt-4o-mini', keyLabel: 'OpenRouter API key' },
  { id: 'deepseek', label: 'DeepSeek – API', kind: 'api', description: 'Calls DeepSeek through its OpenAI-compatible API.', defaultModel: 'deepseek-chat', keyLabel: 'DeepSeek API key' },
] as const;

export const API_PROVIDERS = PROVIDERS.filter(provider => provider.kind === 'api') as readonly (ProviderDefinition & { id: ApiProvider })[];
export const AGENT_PROVIDERS = PROVIDERS.filter(provider => provider.kind === 'agent') as readonly (ProviderDefinition & { id: AgentProvider })[];
export const getProviderDefinition = (id: GenerationProvider) => PROVIDERS.find(provider => provider.id === id) ?? PROVIDERS[0];

export interface ProviderSettings {
  defaultProvider: GenerationProvider;
  models: Record<GenerationProvider, string>;
}

const defaultModels = Object.fromEntries(PROVIDERS.map(provider => [provider.id, provider.defaultModel])) as Record<GenerationProvider, string>;
const defaults: ProviderSettings = { defaultProvider: 'codex', models: defaultModels };

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
    };
  } catch {
    return defaults;
  }
};

export const setProviderSettings = (settings: ProviderSettings) => {
  localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event('quizzer:provider-settings'));
};

export const getApiKey = (provider: GenerationProvider) => sessionStorage.getItem(`${API_KEY_PREFIX}${provider}`) ?? '';

export const setApiKey = (provider: GenerationProvider, value: string) => {
  const key = `${API_KEY_PREFIX}${provider}`;
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
};

// Retain the old Gemini key for users upgrading from earlier Quizzer builds.
export const migrateLegacyGeminiKey = () => {
  const legacy = sessionStorage.getItem('quizzer.geminiApiKey');
  if (legacy && !getApiKey('gemini')) setApiKey('gemini', legacy);
  if (legacy) sessionStorage.removeItem('quizzer.geminiApiKey');
};

export const getGeminiApiKey = () => getApiKey('gemini');
export const setGeminiApiKey = (value: string) => setApiKey('gemini', value);
