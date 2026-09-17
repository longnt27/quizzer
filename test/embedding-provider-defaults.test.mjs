import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmbeddingProvider } from '../server/plugin-embeddings.mjs';

test('uses cloud provider defaults when the embedding model still comes from the hardware profile', async () => {
  const openaiRoute = await resolveEmbeddingProvider({
    values: {
      'embeddings.provider': 'openai',
      'embeddings.model': 'all-minilm',
      'embeddings.allowRemote': true,
    },
    sources: { 'embeddings.model': 'profile:balanced' },
  }, { getCredential: () => 'key', openai: async () => [[1]] });
  const geminiRoute = await resolveEmbeddingProvider({
    values: {
      'embeddings.provider': 'gemini',
      'embeddings.model': 'bge-m3',
      'embeddings.allowRemote': true,
    },
    sources: { 'embeddings.model': 'profile:max' },
  }, { getCredential: () => 'key', gemini: async () => [[1]] });
  assert.equal(openaiRoute.identity, 'openai:text-embedding-3-small');
  assert.equal(geminiRoute.identity, 'gemini:gemini-embedding-2:768:retrieval-v1');
});
