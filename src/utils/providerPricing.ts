import type { GenerationProvider, ProviderPricing, ProviderUsageCapability } from '../types';

// Prices are release-time snapshots as of 2026-09-07, never fetched at runtime.
// DeepSeek uses conservative peak/cache-miss rates because this contract does
// not model cache hits or off-peak windows. Sources:
// https://ai.google.dev/gemini-api/docs/pricing, https://www.anthropic.com/pricing,
// https://openai.com/api/pricing/, https://openrouter.ai/openai/gpt-4o-mini,
// https://api-docs.deepseek.com/quick_start/pricing.
const PRICES: Record<string, ProviderPricing> = {
  'gemini:gemini-2.5-flash': { inputMicroUsdPerMillionTokens: 300_000, outputMicroUsdPerMillionTokens: 2_500_000 },
  'anthropic:claude-sonnet-4-5-20250929': { inputMicroUsdPerMillionTokens: 3_000_000, outputMicroUsdPerMillionTokens: 15_000_000 },
  'openai:gpt-5-mini': { inputMicroUsdPerMillionTokens: 250_000, outputMicroUsdPerMillionTokens: 2_000_000 },
  'openrouter:openai/gpt-4o-mini': { inputMicroUsdPerMillionTokens: 150_000, outputMicroUsdPerMillionTokens: 600_000 },
  'deepseek:deepseek-v4-flash': { inputMicroUsdPerMillionTokens: 440_000, outputMicroUsdPerMillionTokens: 1_320_000 },
};

export const getProviderPricing = (provider: GenerationProvider, model?: string): ProviderPricing | undefined =>
  PRICES[`${provider}:${model ?? ''}`];

export const getProviderUsageCapability = (provider: GenerationProvider): ProviderUsageCapability =>
  ['gemini', 'anthropic', 'openai', 'openrouter', 'deepseek', 'openai-compatible'].includes(provider)
    ? 'provider-reported' : 'unavailable';

export const getKnownProviderRouteMetadata = (provider: GenerationProvider, model?: string) => ({
  pricing: getProviderPricing(provider, model) ?? (['plugin', 'ollama', 'codex', 'claude-agent', 'antigravity-agent'].includes(provider)
    ? { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 } : undefined),
  usage: getProviderUsageCapability(provider),
});
