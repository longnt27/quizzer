import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProviderError, ProviderError } from '../server/provider-error.mjs';

test('normalizes provider failures without crashing the service error path', () => {
  const limit = normalizeProviderError(new Error('The provider rate limit was reached'));
  assert.ok(limit instanceof ProviderError);
  assert.equal(limit.status, 429);
  assert.equal(limit.code, 'provider_limit');

  const auth = normalizeProviderError(new Error('API key is missing'));
  assert.equal(auth.status, 401);
  assert.equal(auth.code, 'provider_auth');

  const missing = normalizeProviderError(Object.assign(new Error('ollama is not installed'), { code: 'ENOENT' }));
  assert.equal(missing.status, 503);
  assert.equal(missing.code, 'provider_unavailable');
});

test('preserves structured provider and cancellation errors', () => {
  const provider = Object.assign(new Error('Provider request failed'), { status: 502, code: 'provider_unavailable' });
  assert.strictEqual(normalizeProviderError(provider), provider);

  const cancelled = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  assert.strictEqual(normalizeProviderError(cancelled), cancelled);
});
