import { PROVIDER_POLICIES } from './provider-policy.mjs';

const API_PROVIDERS = Object.freeze(Object.entries(PROVIDER_POLICIES)
  .filter(([, policy]) => policy.billing === 'usage-based')
  .map(([provider]) => provider));
const API_PROVIDER_SET = new Set(API_PROVIDERS);
const ENVIRONMENT_KEYS = Object.freeze(Object.fromEntries(API_PROVIDERS.map(provider => [
  provider,
  `QUIZZER_${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`,
])));

const validateProvider = provider => {
  if (!API_PROVIDER_SET.has(provider)) throw new Error('Unsupported credential provider');
  return provider;
};

const validateCredential = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) {
    throw new Error('Credential value is invalid');
  }
  return value.trim();
};

export class ProviderCredentialStore {
  constructor(environment = process.env) {
    this.environment = environment;
    this.values = new Map();
  }

  replace(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Provider credentials must be an object');
    }
    const next = new Map();
    for (const [provider, value] of Object.entries(values)) {
      validateProvider(provider);
      if (value === undefined || value === null || value === '') continue;
      next.set(provider, validateCredential(value));
    }
    this.values = next;
    return this.status();
  }

  set(provider, value) {
    validateProvider(provider);
    if (value === undefined || value === null || value === '') this.values.delete(provider);
    else this.values.set(provider, validateCredential(value));
    return this.status();
  }

  get(provider) {
    validateProvider(provider);
    const environmentValue = this.environment[ENVIRONMENT_KEYS[provider]];
    return this.values.get(provider) || (typeof environmentValue === 'string' ? environmentValue.trim() : '') || undefined;
  }

  status() {
    return {
      providers: API_PROVIDERS.filter(provider => Boolean(this.get(provider))),
    };
  }
}

export const providerCredentialEnvironmentKey = provider => ENVIRONMENT_KEYS[validateProvider(provider)];
