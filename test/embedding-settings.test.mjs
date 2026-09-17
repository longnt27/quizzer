import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSettings, SETTINGS_SCHEMA, validateSettings } from '../server/settings.mjs';

test('exposes embedding provider, remote permission, and custom endpoint settings', () => {
  const resolved = resolveSettings({ profile: 'balanced', environment: {} });
  assert.equal(resolved.values['embeddings.provider'], 'ollama');
  assert.equal(resolved.values['embeddings.allowRemote'], false);
  assert.equal(resolved.values['embeddings.openaiCompatible.endpoint'], 'http://127.0.0.1:8080/v1');
  assert.deepEqual(SETTINGS_SCHEMA.properties['embeddings.provider'].enum, ['ollama', 'openai-compatible', 'openai', 'gemini', 'plugin']);
  assert.equal(SETTINGS_SCHEMA.properties['embeddings.provider']['x-quizzer-reindex-required'], true);
  assert.equal(SETTINGS_SCHEMA.properties['embeddings.openaiCompatible.endpoint']['x-quizzer-reindex-required'], true);
});

test('migrates legacy non-builtin embedder settings to the plugin provider', () => {
  const resolved = resolveSettings({
    profile: 'balanced', environment: {},
    user: { 'embeddings.embedderPlugin': 'dev.quizzer.embedder' },
  });
  assert.equal(resolved.values['embeddings.provider'], 'plugin');
  assert.equal(resolved.sources['embeddings.provider'], 'user');
});

test('validates embedding provider and remote endpoint settings', () => {
  assert.deepEqual(validateSettings({ 'embeddings.provider': 'gemini' }), { 'embeddings.provider': 'gemini' });
  assert.deepEqual(validateSettings({ 'embeddings.allowRemote': true }), { 'embeddings.allowRemote': true });
  assert.deepEqual(validateSettings({ 'embeddings.openaiCompatible.endpoint': 'http://127.0.0.1:8080/v1' }), { 'embeddings.openaiCompatible.endpoint': 'http://127.0.0.1:8080/v1' });
  assert.throws(() => validateSettings({ 'embeddings.provider': 'random-cloud' }), /must be one of/);
  assert.throws(() => validateSettings({ 'embeddings.openaiCompatible.endpoint': 'http://example.com/v1' }), /HTTPS/i);
});
