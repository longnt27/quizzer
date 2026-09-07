// Release-time snapshots as of 2026-09-07; no network calls at runtime.
// DeepSeek uses conservative peak/cache-miss rates because cache hits and
// off-peak windows are not modeled. Sources:
// https://ai.google.dev/gemini-api/docs/pricing, https://www.anthropic.com/pricing,
// https://openai.com/api/pricing/, https://openrouter.ai/openai/gpt-4o-mini,
// https://api-docs.deepseek.com/quick_start/pricing.
const PRICES = Object.freeze({
  'gemini:gemini-2.5-flash': Object.freeze({ inputMicroUsdPerMillionTokens: 300_000, outputMicroUsdPerMillionTokens: 2_500_000 }),
  'anthropic:claude-sonnet-4-5-20250929': Object.freeze({ inputMicroUsdPerMillionTokens: 3_000_000, outputMicroUsdPerMillionTokens: 15_000_000 }),
  'openai:gpt-5-mini': Object.freeze({ inputMicroUsdPerMillionTokens: 250_000, outputMicroUsdPerMillionTokens: 2_000_000 }),
  'openrouter:openai/gpt-4o-mini': Object.freeze({ inputMicroUsdPerMillionTokens: 150_000, outputMicroUsdPerMillionTokens: 600_000 }),
  'deepseek:deepseek-v4-flash': Object.freeze({ inputMicroUsdPerMillionTokens: 440_000, outputMicroUsdPerMillionTokens: 1_320_000 }),
});

export const getProviderPricing = (provider, model) => PRICES[`${provider}:${model ?? ''}`];
export const getProviderUsageCapability = provider =>
  ['gemini', 'anthropic', 'openai', 'openrouter', 'deepseek', 'openai-compatible'].includes(provider)
    ? 'provider-reported' : 'unavailable';
export const getKnownProviderRouteMetadata = (provider, model) => ({
  pricing: getProviderPricing(provider, model) ?? (['plugin', 'ollama', 'llama-cpp', 'codex', 'claude-agent', 'antigravity-agent'].includes(provider)
    ? { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 } : undefined),
  usage: getProviderUsageCapability(provider),
});
