import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmbeddingProvider } from '../server/plugin-embeddings.mjs';
import { ProviderCredentialStore } from '../server/provider-credentials.mjs';

const openAISettings = {
  values: {
    'embeddings.provider': 'openai',
    'embeddings.model': 'text-embedding-3-small',
    'embeddings.allowRemote': true,
  },
};

test('embedding routes do not read the most recently constructed credential store implicitly', async () => {
  delete process.env.QUIZZER_OPENAI_API_KEY;
  const store = new ProviderCredentialStore({});
  store.replace({ openai: ' volatile-key ' });
  let called = false;
  const route = await resolveEmbeddingProvider(openAISettings, {
    openai: async () => { called = true; return [[1]]; },
  });

  await assert.rejects(
    route.embed(['private notes']),
    error => error.code === 'provider_unavailable' && /credential/.test(error.message),
  );
  assert.equal(called, false);
});

test('credential stores read only their own volatile values and injected environment', () => {
  const first = new ProviderCredentialStore({ QUIZZER_GEMINI_API_KEY: ' env-key ' });
  first.replace({ openai: ' first-key ' });
  const second = new ProviderCredentialStore({});
  second.replace({ openai: ' second-key ' });

  assert.equal(first.get('openai'), 'first-key');
  assert.equal(first.get('gemini'), 'env-key');
  assert.equal(second.get('openai'), 'second-key');
  assert.equal(second.get('gemini'), undefined);
});
