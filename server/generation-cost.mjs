const MAX_SAFE = Number.MAX_SAFE_INTEGER;
export const MICRO_USD_PER_USD = 1_000_000;

export const validateUsageInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a finite non-negative safe integer`);
  return value;
};

export const validateMicroUsd = (value, label = 'Cost') => validateUsageInteger(value, label);

export const validateCostCeiling = value => {
  if (value === undefined || value === null) return undefined;
  return validateMicroUsd(value, 'Cost ceiling');
};

const sumSafe = (a, b, label) => {
  validateUsageInteger(a, label); validateUsageInteger(b, label);
  if (a > MAX_SAFE - b) throw new Error(`${label} exceeds the safe integer range`);
  return a + b;
};

export const normalizeProviderUsage = usage => {
  if (usage === undefined || usage === null) return undefined;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('Provider usage must be an object');
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens;
  if (inputTokens === undefined || outputTokens === undefined) throw new Error('Provider usage must include input and output token counts');
  validateUsageInteger(inputTokens, 'Provider input token count');
  validateUsageInteger(outputTokens, 'Provider output token count');
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? sumSafe(inputTokens, outputTokens, 'Provider token count');
  validateUsageInteger(totalTokens, 'Provider total token count');
  if (totalTokens !== inputTokens + outputTokens) throw new Error('Provider total token count does not match input and output counts');
  const costMicroUsd = usage.costMicroUsd ?? usage.cost_micro_usd;
  if (costMicroUsd !== undefined) validateMicroUsd(costMicroUsd, 'Provider reported cost');
  return { inputTokens, outputTokens, totalTokens, ...(costMicroUsd === undefined ? {} : { costMicroUsd }) };
};

export const routePricing = route => {
  const pricing = route?.pricing;
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return undefined;
  const inputMicroUsdPerToken = validateMicroUsd(pricing.inputMicroUsdPerToken, 'Input token price');
  const outputMicroUsdPerToken = validateMicroUsd(pricing.outputMicroUsdPerToken, 'Output token price');
  return { inputMicroUsdPerToken, outputMicroUsdPerToken };
};

export const estimateRouteCost = (route, usage) => {
  const normalized = normalizeProviderUsage(usage);
  const pricing = routePricing(route);
  if (!pricing) return undefined;
  const input = normalized.inputTokens * pricing.inputMicroUsdPerToken;
  const output = normalized.outputTokens * pricing.outputMicroUsdPerToken;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input > MAX_SAFE - output) {
    throw new Error('Estimated provider cost exceeds the safe integer range');
  }
  return input + output;
};

export const finalizeUsageCost = (route, usage) => {
  const normalized = normalizeProviderUsage(usage);
  const estimated = estimateRouteCost(route, normalized);
  if (normalized.costMicroUsd !== undefined) return normalized.costMicroUsd;
  return estimated;
};

export const emptyUsageSummary = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0, finalizedCostMicroUsd: 0, reservedCostMicroUsd: 0 });

export const addUsageSummary = (summary = emptyUsageSummary, usage, finalizedCostMicroUsd, reservedCostMicroUsd = 0) => {
  const normalized = normalizeProviderUsage(usage);
  const result = {
    inputTokens: sumSafe(summary.inputTokens ?? 0, normalized.inputTokens, 'Cumulative input tokens'),
    outputTokens: sumSafe(summary.outputTokens ?? 0, normalized.outputTokens, 'Cumulative output tokens'),
    totalTokens: sumSafe(summary.totalTokens ?? 0, normalized.totalTokens, 'Cumulative tokens'),
    finalizedCostMicroUsd: sumSafe(summary.finalizedCostMicroUsd ?? 0, finalizedCostMicroUsd ?? 0, 'Cumulative finalized cost'),
    reservedCostMicroUsd: sumSafe(summary.reservedCostMicroUsd ?? 0, reservedCostMicroUsd, 'Cumulative reserved cost'),
  };
  return result;
};
