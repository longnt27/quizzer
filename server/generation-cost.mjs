/* Generation billing is integer micro-US dollars. Provider-reported cost is telemetry only. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIGINT = BigInt(MAX_SAFE);
export const MICRO_USD_PER_USD = 1_000_000;
export const TOKENS_PER_MILLION = 1_000_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const validateUsageInteger = (value, label = 'Usage value') => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a finite non-negative safe integer`);
  return value;
};
export const validateMicroUsd = (value, label = 'Cost') => validateUsageInteger(value, label);
export const validateCostCeiling = value => value === undefined || value === null
  ? undefined : validateMicroUsd(value, 'Cost ceiling');

const safeAdd = (a, b, label) => {
  validateUsageInteger(a, label); validateUsageInteger(b, label);
  const result = BigInt(a) + BigInt(b);
  if (result > MAX_SAFE_BIGINT) throw new Error(`${label} exceeds the safe integer range`);
  return Number(result);
};
const safeMultiplyRoundUp = (tokens, microUsdPerMillion, label) => {
  validateUsageInteger(tokens, `${label} token count`);
  validateMicroUsd(microUsdPerMillion, `${label} price`);
  const result = (BigInt(tokens) * BigInt(microUsdPerMillion) + 999_999n) / 1_000_000n;
  if (result > MAX_SAFE_BIGINT) throw new Error(`${label} exceeds the safe integer range`);
  return Number(result);
};
const aliasedValue = (object, names, label) => {
  const present = names.filter(name => object[name] !== undefined && object[name] !== null).map(name => object[name]);
  if (present.length > 1 && present.some(value => value !== present[0])) throw new Error(`${label} aliases disagree`);
  return present[0];
};

export const normalizeProviderUsage = usage => {
  if (usage === undefined || usage === null) return undefined;
  if (!isObject(usage)) throw new Error('Provider usage must be an object');
  const usageKeys = new Set([
    'inputTokens', 'input_tokens', 'prompt_tokens', 'outputTokens', 'output_tokens', 'completion_tokens',
    'totalTokens', 'total_tokens', 'costMicroUsd', 'cost_micro_usd', 'unknown', 'reason',
  ]);
  const unknownKeys = Object.keys(usage).filter(key => !usageKeys.has(key));
  if (unknownKeys.length) throw new Error(`Provider usage contains unsupported fields: ${unknownKeys.join(', ')}`);
  // Provider adapters use this bounded marker when a response was malformed,
  // interrupted, or did not expose usage. It is not billable evidence.
  if (usage.unknown === true) {
    const keys = Object.keys(usage);
    if (keys.some(key => !['unknown', 'reason'].includes(key)) || !['missing', 'malformed', 'overflow'].includes(usage.reason)) {
      throw new Error('Unknown provider usage marker is invalid');
    }
    return undefined;
  }
  const inputTokens = aliasedValue(usage, ['inputTokens', 'input_tokens', 'prompt_tokens'], 'Provider input token count');
  const outputTokens = aliasedValue(usage, ['outputTokens', 'output_tokens', 'completion_tokens'], 'Provider output token count');
  if (inputTokens === undefined || outputTokens === undefined) throw new Error('Provider usage must include input and output token counts');
  validateUsageInteger(inputTokens, 'Provider input token count');
  validateUsageInteger(outputTokens, 'Provider output token count');
  const calculatedTotal = safeAdd(inputTokens, outputTokens, 'Provider token count');
  const totalTokens = aliasedValue(usage, ['totalTokens', 'total_tokens'], 'Provider total token count') ?? calculatedTotal;
  validateUsageInteger(totalTokens, 'Provider total token count');
  if (totalTokens !== calculatedTotal) throw new Error('Provider total token count does not match input and output counts');
  const reportedCost = aliasedValue(usage, ['costMicroUsd', 'cost_micro_usd'], 'Provider reported cost');
  if (reportedCost !== undefined) validateMicroUsd(reportedCost, 'Provider reported cost');
  return { inputTokens, outputTokens, totalTokens, ...(reportedCost === undefined ? {} : { costMicroUsd: reportedCost }) };
};

/* Route snapshots use integer micro-USD per million input/output tokens. */
export const routePricing = route => {
  const pricing = route?.pricing;
  if (pricing === undefined || pricing === null) return undefined;
  if (!isObject(pricing)) throw new Error('Route pricing must be an object');
  const allowed = new Set(['inputMicroUsdPerMillionTokens', 'outputMicroUsdPerMillionTokens']);
  const unknown = Object.keys(pricing).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Route pricing contains unsupported fields: ${unknown.join(', ')}`);
  if (!Object.hasOwn(pricing, 'inputMicroUsdPerMillionTokens') || !Object.hasOwn(pricing, 'outputMicroUsdPerMillionTokens')) {
    throw new Error('Route pricing must include input and output micro-USD per million token prices');
  }
  return {
    inputMicroUsdPerMillionTokens: validateMicroUsd(pricing.inputMicroUsdPerMillionTokens, 'Input token price'),
    outputMicroUsdPerMillionTokens: validateMicroUsd(pricing.outputMicroUsdPerMillionTokens, 'Output token price'),
  };
};

export const estimateRouteCost = (route, usage) => {
  const normalized = normalizeProviderUsage(usage);
  if (!normalized) return undefined;
  const pricing = routePricing(route);
  if (!pricing) return undefined;
  return safeAdd(
    safeMultiplyRoundUp(normalized.inputTokens, pricing.inputMicroUsdPerMillionTokens, 'Estimated input cost'),
    safeMultiplyRoundUp(normalized.outputTokens, pricing.outputMicroUsdPerMillionTokens, 'Estimated output cost'),
    'Estimated provider cost',
  );
};
/* Provider-reported cost is deliberately ignored. */
export const finalizeUsageCost = (route, usage) => estimateRouteCost(route, usage);
export const priceProviderUsage = estimateRouteCost;
export const computeUsageCost = estimateRouteCost;

export const emptyUsageSummary = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0, finalizedCostMicroUsd: 0, reservedCostMicroUsd: 0 });
export const normalizeUsageSummary = (summary = emptyUsageSummary) => {
  if (!isObject(summary)) throw new Error('Generation usage summary is invalid');
  const allowed = new Set(Object.keys(emptyUsageSummary));
  const unknown = Object.keys(summary).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Generation usage summary contains unsupported fields: ${unknown.join(', ')}`);
  const result = {};
  for (const key of allowed) result[key] = validateUsageInteger(summary[key] ?? 0, `Generation usage ${key}`);
  if (result.totalTokens !== safeAdd(result.inputTokens, result.outputTokens, 'Generation usage total tokens')) throw new Error('Generation usage total tokens do not match input and output totals');
  return result;
};
export const addUsageSummary = (summary = emptyUsageSummary, usage, finalizedCostMicroUsd = 0, reservedCostMicroUsd = 0) => {
  const prior = normalizeUsageSummary(summary);
  const normalized = normalizeProviderUsage(usage);
  const result = {
    inputTokens: prior.inputTokens, outputTokens: prior.outputTokens, totalTokens: prior.totalTokens,
    finalizedCostMicroUsd: safeAdd(prior.finalizedCostMicroUsd, finalizedCostMicroUsd, 'Cumulative finalized cost'),
    reservedCostMicroUsd: safeAdd(prior.reservedCostMicroUsd, reservedCostMicroUsd, 'Cumulative reserved cost'),
  };
  if (normalized) {
    result.inputTokens = safeAdd(result.inputTokens, normalized.inputTokens, 'Cumulative input tokens');
    result.outputTokens = safeAdd(result.outputTokens, normalized.outputTokens, 'Cumulative output tokens');
    result.totalTokens = safeAdd(result.totalTokens, normalized.totalTokens, 'Cumulative tokens');
  }
  return result;
};

export const assertCostWithinCeiling = (ceilingMicroUsd, finalizedCostMicroUsd, reservedCostMicroUsd = 0) => {
  const ceiling = validateCostCeiling(ceilingMicroUsd);
  const finalized = validateMicroUsd(finalizedCostMicroUsd, 'Finalized cost');
  const reserved = validateMicroUsd(reservedCostMicroUsd, 'Reserved cost');
  if (ceiling === undefined) return true;
  if (BigInt(finalized) + BigInt(reserved) > BigInt(ceiling)) throw new Error('Generation cost ceiling would be exceeded');
  return true;
};
export const costWithinCeiling = (ceilingMicroUsd, finalizedCostMicroUsd, reservedCostMicroUsd = 0) => {
  try { assertCostWithinCeiling(ceilingMicroUsd, finalizedCostMicroUsd, reservedCostMicroUsd); return true; }
  catch (error) { if (error.message === 'Generation cost ceiling would be exceeded') return false; throw error; }
};
