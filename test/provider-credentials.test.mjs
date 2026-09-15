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
  assert.equal(providerCredentialEnvironmentKey('openai-compatible'), 'QUIZZER_OPENAI_COMPATIBLE_API_KEY');

  const compatStore = new ProviderCredentialStore({ QUIZZER_OPENAI_COMPATIBLE_API_KEY: 'compat-env-key' });
  assert.deepEqual(compatStore.status(), { providers: ['openai-compatible'] });
  assert.equal(compatStore.get('openai-compatible'), 'compat-env-key');
  compatStore.set('openai-compatible', 'custom-key');
  assert.equal(compatStore.get('openai-compatible'), 'custom-key');
  assert.equal(JSON.stringify(compatStore.status()).includes('custom-key'), false);
});

test('supports the Mistral OCR tool credential without exposing its value', () => {
  const store = new ProviderCredentialStore({ QUIZZER_MISTRAL_OCR_API_KEY: ' env-mistral-key ' });
  assert.deepEqual(store.status(), { providers: ['mistral-ocr'] });
  assert.equal(store.get('mistral-ocr'), 'env-mistral-key');
  assert.equal(providerCredentialEnvironmentKey('mistral-ocr'), 'QUIZZER_MISTRAL_OCR_API_KEY');

  store.set('mistral-ocr', 'session-mistral-key');
  assert.equal(store.get('mistral-ocr'), 'session-mistral-key');
  assert.equal(JSON.stringify(store.status()).includes('session-mistral-key'), false);
});

test('rejects unknown providers and malformed credential collections', () => {
  const store = new ProviderCredentialStore({});
  assert.throws(() => store.replace(null), /must be an object/);
  assert.throws(() => store.replace({ codex: 'not-an-api-key' }), /Unsupported credential provider/);
  assert.throws(() => store.replace({ openai: 42 }), /Credential value is invalid/);
  assert.throws(() => store.set('unknown', 'value'), /Unsupported credential provider/);
  assert.throws(() => store.get('unknown'), /Unsupported credential provider/);
});
