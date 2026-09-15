import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderCredentialStore, getProviderCredential } from '../server/provider-credentials.mjs';

test('exposes the active volatile credential to service-owned embedding routes without copying it to process.env', () => {
  delete process.env.QUIZZER_OPENAI_API_KEY;
  const store = new ProviderCredentialStore({});
  store.replace({ openai: ' volatile-key ' });
  assert.equal(getProviderCredential('openai'), 'volatile-key');
  assert.equal(process.env.QUIZZER_OPENAI_API_KEY, undefined);
});

test('falls back to the process environment when no active store credential exists', () => {
  const store = new ProviderCredentialStore({ QUIZZER_GEMINI_API_KEY: ' env-key ' });
  assert.equal(store.get('gemini'), 'env-key');
  assert.equal(getProviderCredential('gemini'), 'env-key');
});
