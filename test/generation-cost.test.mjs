import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addUsageSummary, assertCostWithinCeiling, estimateRouteCost, finalizeUsageCost,
  normalizeProviderUsage, routePricing,
} from '../server/generation-cost.mjs';

const route = { pricing: { inputMicroUsdPerMillionTokens: 1_500_001, outputMicroUsdPerMillionTokens: 2_000_001 } };

test('prices per-million token rates with integer round-up and ignores provider cost claims', () => {
  assert.equal(estimateRouteCost(route, { inputTokens: 1, outputTokens: 1, costMicroUsd: 0 }), 5);
  assert.equal(finalizeUsageCost(route, { inputTokens: 1_000_000, outputTokens: 0, costMicroUsd: 1 }), 1_500_001);
  assert.equal(estimateRouteCost(route, undefined), undefined);
});

test('rejects unsafe usage and pricing arithmetic before it reaches Number overflow', () => {
  assert.throws(() => normalizeProviderUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), /safe integer range/);
  assert.throws(() => estimateRouteCost({ pricing: { inputMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER, outputMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER } }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }), /safe integer range/);
  assert.throws(() => routePricing({ pricing: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 } }), /unsupported fields|include input and output/);
});

test('missing usage leaves an unresolved conservative reservation and ceilings include reservations', () => {
  const summary = addUsageSummary(undefined, undefined, 0, 9);
  assert.deepEqual(summary, { inputTokens: 0, outputTokens: 0, totalTokens: 0, finalizedCostMicroUsd: 0, reservedCostMicroUsd: 9 });
  assert.throws(() => assertCostWithinCeiling(10, 2, 9), /ceiling/);
  assert.equal(assertCostWithinCeiling(undefined, Number.MAX_SAFE_INTEGER, 0), true);
});
