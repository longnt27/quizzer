import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderCredentialStore, providerCredentialEnvironmentKey } from '../server/provider-credentials.mjs';

test('keeps provider credentials in memory and exposes names only', () => {
  const store = new ProviderCredentialStore({ QUIZZER_OPENAI_API_KEY: ' environment-key ' });
  assert.deepEqual(store.status(), { providers: ['openai'] });
  assert.equal(store.get('openai'), 'environment-key');

  assert.deepEqual(store.replace({ gemini: ' session-key ', deepseek: '' }), { providers: ['gemini', 'openai'] });
  assert.equal(store.get('gemini'), 'session-key');
  assert.equal(JSON.stringify(store.status()).includes('session-key'), false);

  store.set('gemini', '');
  assert.equal(store.get('gemini'), undefined);
  assert.equal(providerCredentialEnvironmentKey('deepseek'), 'QUIZZER_DEEPSEEK_API_KEY');
});

test('rejects unknown providers and malformed credential collections', () => {
  const store = new ProviderCredentialStore({});
  assert.throws(() => store.replace(null), /must be an object/);
  assert.throws(() => store.replace({ codex: 'not-an-api-key' }), /Unsupported credential provider/);
  assert.throws(() => store.replace({ openai: 42 }), /Credential value is invalid/);
  assert.throws(() => store.set('unknown', 'value'), /Unsupported credential provider/);
  assert.throws(() => store.get('unknown'), /Unsupported credential provider/);
});
