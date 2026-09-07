import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_USAGE_TOKENS, normalizeProviderUsage } from '../server/provider-usage.mjs';

test('normalizes OpenAI and Ollama token usage and ignores monetary claims', () => {
  assert.deepEqual(normalizeProviderUsage('openai-compatible', {
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 999 },
  }), { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  assert.deepEqual(normalizeProviderUsage('ollama', { prompt_eval_count: 12, eval_count: 8 }), {
    inputTokens: 12, outputTokens: 8, totalTokens: 20,
  });
});

test('reports missing, malformed, and overflowing usage explicitly', () => {
  assert.deepEqual(normalizeProviderUsage('ollama', {}), { unknown: true, reason: 'missing' });
  assert.deepEqual(normalizeProviderUsage('ollama', { prompt_eval_count: '12', eval_count: 8 }), { unknown: true, reason: 'malformed' });
  assert.deepEqual(normalizeProviderUsage('ollama', { prompt_eval_count: MAX_USAGE_TOKENS + 1, eval_count: 8 }), { unknown: true, reason: 'overflow' });
  assert.deepEqual(normalizeProviderUsage('openai-compatible', { usage: { prompt_tokens: MAX_USAGE_TOKENS, completion_tokens: 1 } }), { unknown: true, reason: 'overflow' });
});
