// Release-time snapshots; no network calls at runtime. Sources:
// https://ai.google.dev/gemini-api/docs/pricing, https://www.anthropic.com/pricing,
// https://openai.com/api/pricing/, https://openrouter.ai/openai/gpt-4o-mini,
// https://api-docs.deepseek.com/quick_start/pricing.
const PRICES = Object.freeze({
  'gemini:gemini-2.5-flash': Object.freeze({ inputMicroUsdPerMillionTokens: 300_000, outputMicroUsdPerMillionTokens: 2_500_000 }),
  'anthropic:claude-sonnet-4-5-20250929': Object.freeze({ inputMicroUsdPerMillionTokens: 3_000_000, outputMicroUsdPerMillionTokens: 15_000_000 }),
  'openai:gpt-5-mini': Object.freeze({ inputMicroUsdPerMillionTokens: 250_000, outputMicroUsdPerMillionTokens: 2_000_000 }),
  'openrouter:openai/gpt-4o-mini': Object.freeze({ inputMicroUsdPerMillionTokens: 150_000, outputMicroUsdPerMillionTokens: 600_000 }),
  // deepseek-chat is the compatibility alias for DeepSeek-V4-Flash. Use the
  // cache-miss input rate because cache hits are not modeled by this contract.
  'deepseek:deepseek-chat': Object.freeze({ inputMicroUsdPerMillionTokens: 140_000, outputMicroUsdPerMillionTokens: 280_000 }),
});

export const getProviderPricing = (provider, model) => PRICES[`${provider}:${model ?? ''}`];
export const getProviderUsageCapability = provider =>
  ['gemini', 'anthropic', 'openai', 'openrouter', 'deepseek', 'openai-compatible'].includes(provider)
    ? 'provider-reported' : 'unavailable';
export const getKnownProviderRouteMetadata = (provider, model) => ({
  pricing: getProviderPricing(provider, model) ?? (['plugin', 'ollama', 'codex', 'claude-agent', 'antigravity-agent'].includes(provider)
    ? { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 } : undefined),
  usage: getProviderUsageCapability(provider),
});
