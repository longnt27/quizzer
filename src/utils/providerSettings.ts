const GEMINI_KEY = 'quizzer.geminiApiKey';
const PROVIDER_SETTINGS_KEY = 'quizzer.providerSettings';

export interface ProviderSettings {
  defaultProvider: 'codex' | 'gemini';
  codexModel: string;
  geminiModel: string;
}

const defaults: ProviderSettings = {
  defaultProvider: 'codex',
  codexModel: '',
  geminiModel: 'gemini-2.5-flash',
};

export const getProviderSettings = (): ProviderSettings => {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PROVIDER_SETTINGS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
};

export const setProviderSettings = (settings: ProviderSettings) => {
  localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event('quizzer:provider-settings'));
};

export const getGeminiApiKey = () => sessionStorage.getItem(GEMINI_KEY) ?? '';

export const setGeminiApiKey = (value: string) => {
  if (value) sessionStorage.setItem(GEMINI_KEY, value);
  else sessionStorage.removeItem(GEMINI_KEY);
};
