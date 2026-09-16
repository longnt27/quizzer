import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

test('service injects its volatile credential store into embedding and Mistral routes', () => {
  assert.match(source, /import \{ describeEmbeddingIntegration \} from '\.\/server\/embedding-integration-status\.mjs';/);
  assert.match(source, /const getProviderCredential = provider => providerCredentials\.get\(provider\);/);
  assert.equal((source.match(/getCredential: getProviderCredential/g) ?? []).length, 3);
  assert.match(source, /loadCredential: getProviderCredential/);
  assert.match(source, /describeEmbeddingIntegration\(\{[\s\S]*?credentialProviders: providerCredentials\.status\(\)\.providers[\s\S]*?job: integrationJobs\.embeddings/);
});

test('embedding model installation is rejected unless Ollama is the active embedding provider', () => {
  const start = source.indexOf("request.url === '/api/integrations/embeddings/install'");
  const end = source.indexOf("request.url === '/api/extract'", start);
  assert.ok(start >= 0 && end > start, 'embedding installation route must exist before extraction route');
  const route = source.slice(start, end);
  const guard = route.indexOf("settings.values['embeddings.provider'] !== 'ollama'");
  const install = route.indexOf('installEmbeddings(configuredModel)');
  assert.ok(guard >= 0, 'embedding install route must reject non-Ollama providers');
  assert.ok(install > guard, 'provider guard must run before starting an Ollama model download');
});
