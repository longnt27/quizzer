// Provider usage is deliberately kept independent from pricing. Providers may
// report arbitrary monetary fields; only bounded token counts are accepted.
export const MAX_USAGE_TOKENS = 10_000_000_000;

const unknown = reason => Object.freeze({ unknown: true, reason });

const token = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_USAGE_TOKENS
  ? value : undefined;

const normalized = (promptTokens, completionTokens, totalTokens) => {
  const prompt = token(promptTokens);
  const completion = token(completionTokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const sum = prompt + completion;
  if (!Number.isSafeInteger(sum) || sum > MAX_USAGE_TOKENS) return undefined;
  const total = totalTokens === undefined ? sum : token(totalTokens);
  if (total === undefined || total !== sum) return undefined;
  return Object.freeze({ inputTokens: prompt, outputTokens: completion, totalTokens: total });
};

export const normalizeProviderUsage = (provider, payload) => {
  const source = provider === "ollama" ? payload : payload?.usage;
  if (!source || typeof source !== "object" || Array.isArray(source)) return unknown("missing");
  const fieldNames = provider === "ollama"
    ? ["prompt_eval_count", "eval_count"]
    : ["prompt_tokens", "completion_tokens", "total_tokens"];
  if (!fieldNames.some(name => Object.hasOwn(source, name))) return unknown("missing");
  const usage = provider === "ollama"
    ? normalized(source.prompt_eval_count, source.eval_count)
    : normalized(source.prompt_tokens, source.completion_tokens, source.total_tokens);
  if (usage) return usage;
  const fields = provider === "ollama"
    ? [source.prompt_eval_count, source.eval_count]
    : [source.prompt_tokens, source.completion_tokens, source.total_tokens];
  return fields.some(value => typeof value === "number" && (!Number.isSafeInteger(value) || value < 0 || value > MAX_USAGE_TOKENS))
    || (fields[0] <= MAX_USAGE_TOKENS && fields[1] <= MAX_USAGE_TOKENS
      && Number.isSafeInteger(fields[0]) && Number.isSafeInteger(fields[1])
      && fields[0] + fields[1] > MAX_USAGE_TOKENS)
    ? unknown("overflow") : unknown("malformed");
};

export const unknownProviderUsage = reason => unknown(
  reason === "overflow" ? "overflow" : reason === "malformed" ? "malformed" : "missing",
);
