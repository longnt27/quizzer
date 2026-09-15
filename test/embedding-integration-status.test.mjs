import assert from 'node:assert/strict';
import test from 'node:test';
import { describeEmbeddingIntegration } from '../server/embedding-integration-status.mjs';

const job = { state: 'idle', message: '' };

const settings = values => ({ values: {
  'embeddings.enabled': true,
  'embeddings.embedderPlugin': 'builtin',
  'embeddings.allowRemote': false,
  'embeddings.openaiCompatible.endpoint': 'http://127.0.0.1:8080/v1',
  ...values,
} });

test('reports Ollama installation and runtime readiness for the selected embedding model', () => {
  const status = describeEmbeddingIntegration({
    settings: settings({ 'embeddings.provider': 'ollama', 'embeddings.model': 'bge-m3' }),
    ollama: { serverReady: true, models: [{ name: 'bge-m3:latest' }] },
    ollamaInstalled: true,
    credentialProviders: [],
    job,
  });

  assert.deepEqual(status, {
    provider: 'ollama',
    model: 'bge-m3',
    privacy: 'local',
    installable: true,
    installed: true,
    runtimeInstalled: true,
    credentialConfigured: true,
    status: 'ready',
    job,
  });
});

test('reports cloud embedding readiness without a fake installation state', () => {
  const missing = describeEmbeddingIntegration({
    settings: settings({
      'embeddings.provider': 'openai',
      'embeddings.model': 'text-embedding-3-small',
      'embeddings.allowRemote': true,
    }),
    ollama: { serverReady: false, models: [] },
    ollamaInstalled: false,
    credentialProviders: [],
    job,
  });
  assert.equal(missing.provider, 'openai');
  assert.equal(missing.privacy, 'remote-api');
  assert.equal(missing.installable, false);
  assert.equal(missing.credentialConfigured, false);
  assert.equal(missing.status, 'credential-required');
  assert.equal('installed' in missing, false);
  assert.equal('runtimeInstalled' in missing, false);

  const ready = describeEmbeddingIntegration({
    settings: settings({
      'embeddings.provider': 'gemini',
      'embeddings.model': 'gemini-embedding-2',
      'embeddings.allowRemote': true,
    }),
    ollama: { serverReady: false, models: [] },
    ollamaInstalled: false,
    credentialProviders: ['gemini'],
    job,
  });
  assert.equal(ready.provider, 'gemini');
  assert.equal(ready.credentialConfigured, true);
  assert.equal(ready.status, 'ready');
  assert.equal('installed' in ready, false);
});

test('treats loopback OpenAI-compatible embeddings as local and credential-optional', () => {
  const local = describeEmbeddingIntegration({
    settings: settings({
      'embeddings.provider': 'openai-compatible',
      'embeddings.model': 'nomic-embed-text',
      'embeddings.openaiCompatible.endpoint': 'http://127.0.0.1:11434/v1',
    }),
    ollama: { serverReady: false, models: [] },
    ollamaInstalled: false,
    credentialProviders: [],
    job,
  });

  assert.equal(local.provider, 'openai-compatible');
  assert.equal(local.privacy, 'local');
  assert.equal(local.installable, false);
  assert.equal(local.credentialConfigured, true);
  assert.equal(local.status, 'ready');
  assert.equal('installed' in local, false);
});
