export const PROVIDER_POLICIES = Object.freeze({
  plugin: Object.freeze({ label: 'Local generator plugin', billing: 'local', privacy: 'local', defaultConcurrency: 1 }),
  ollama: Object.freeze({ label: 'Ollama local model', billing: 'local', privacy: 'local', defaultConcurrency: 1, configurableConcurrency: false }),
  codex: Object.freeze({ label: 'Codex agent', billing: 'account', privacy: 'signed-in-agent', defaultConcurrency: 1 }),
  'claude-agent': Object.freeze({ label: 'Claude agent', billing: 'account', privacy: 'signed-in-agent', defaultConcurrency: 1 }),
  'antigravity-agent': Object.freeze({ label: 'Antigravity agent', billing: 'account', privacy: 'signed-in-agent', defaultConcurrency: 1 }),
  gemini: Object.freeze({ label: 'Gemini API', billing: 'usage-based', privacy: 'remote-api', defaultConcurrency: 3 }),
  anthropic: Object.freeze({ label: 'Anthropic API', billing: 'usage-based', privacy: 'remote-api', defaultConcurrency: 2 }),
  openai: Object.freeze({ label: 'OpenAI API', billing: 'usage-based', privacy: 'remote-api', defaultConcurrency: 3 }),
  openrouter: Object.freeze({ label: 'OpenRouter API', billing: 'usage-based', privacy: 'remote-api', defaultConcurrency: 3 }),
  deepseek: Object.freeze({ label: 'DeepSeek API', billing: 'usage-based', privacy: 'remote-api', defaultConcurrency: 2 }),
});

export const providerConcurrencySettingKey = provider => `providers.${provider}.maxConcurrency`;

export const providerConcurrencyLimits = settings => Object.fromEntries(
  Object.entries(PROVIDER_POLICIES).map(([provider, policy]) => [
    provider,
    settings?.[providerConcurrencySettingKey(provider)] ?? policy.defaultConcurrency,
  ]),
);

export const publicProviderPolicies = settings => {
  const limits = providerConcurrencyLimits(settings);
  return Object.fromEntries(Object.entries(PROVIDER_POLICIES).map(([provider, policy]) => [provider, {
    billing: policy.billing,
    privacy: policy.privacy,
    maxConcurrency: limits[provider],
  }]));
};
