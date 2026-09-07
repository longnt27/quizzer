import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadResolvedSettings, readUserSettings, resolveSettings, SETTINGS_SCHEMA, validateSettings, writeUserSettings,
} from '../server/settings.mjs';
import { providerConcurrencyLimits, publicProviderPolicies } from '../server/provider-policy.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-settings-test-'));
test.after(async () => rm(directory, { recursive: true, force: true }));

test('resolves profile, user, environment, CLI, and job settings in order', () => {
  const resolved = resolveSettings({
    profile: 'lite',
    user: { 'generation.concurrency': 2, 'retrieval.contextBudget': 5000 },
    environment: { QUIZZER_HARDWARE_PROFILE: 'balanced', QUIZZER_GENERATION_CONCURRENCY: '4', QUIZZER_OPENAI_MAX_CONCURRENCY: '4' },
    cli: { 'generation.concurrency': 5 },
    job: { 'generation.concurrency': 6 },
  });
  assert.equal(resolved.profile, 'balanced');
  assert.equal(resolved.values['retrieval.mode'], 'hybrid');
  assert.equal(resolved.values['embeddings.model'], 'all-minilm');
  assert.equal(resolved.values['embeddings.embedderPlugin'], 'builtin');
  assert.equal(resolved.values['retrieval.rerankerPlugin'], 'builtin');
  assert.equal(resolved.values['retrieval.vectorIndexPlugin'], 'builtin');
  assert.equal(resolved.values['extraction.extractorPlugin'], 'builtin');
  assert.equal(resolved.values['extraction.ocrPlugin'], 'builtin');
  assert.equal(resolved.values['retrieval.contextBudget'], 5000);
  assert.equal(resolved.values['generation.concurrency'], 6);
  assert.equal(resolved.sources['generation.concurrency'], 'job');
  assert.equal(resolved.values['providers.openai.maxConcurrency'], 4);
  assert.equal(resolved.sources['providers.openai.maxConcurrency'], 'environment');
  assert.equal(providerConcurrencyLimits(resolved.values).openai, 4);
  assert.equal(providerConcurrencyLimits(resolved.values).ollama, 1);
  assert.equal('providers.ollama.maxConcurrency' in resolved.values, false);
  assert.deepEqual(publicProviderPolicies(resolved.values).openai, {
    billing: 'usage-based', privacy: 'remote-api', maxConcurrency: 4,
  });
  assert.equal(providerConcurrencyLimits(resolved.values)['openai-compatible'], 2);
  assert.deepEqual(publicProviderPolicies(resolved.values)['openai-compatible'], {
    billing: 'usage-based', privacy: 'remote-api', maxConcurrency: 2,
  });
});

test('resolves openai-compatible endpoint with JSONC, env, CLI, and job precedence', () => {
  // Default fallback
  const fallback = resolveSettings({ environment: {} });
  assert.equal(fallback.values['providers.openai-compatible.endpoint'], 'https://api.openai.com/v1');
  assert.equal(fallback.sources['providers.openai-compatible.endpoint'], 'default');

  // JSONC override
  const user = resolveSettings({
    user: { 'providers.openai-compatible.endpoint': 'https://jsonc.example.com/v1' },
    environment: {},
  });
  assert.equal(user.values['providers.openai-compatible.endpoint'], 'https://jsonc.example.com/v1');
  assert.equal(user.sources['providers.openai-compatible.endpoint'], 'user');

  // Environment override
  const env1 = resolveSettings({
    user: { 'providers.openai-compatible.endpoint': 'https://jsonc.example.com/v1' },
    environment: { QUIZZER_OPENAI_COMPATIBLE_ENDPOINT: 'https://env1.example.com/v1' },
  });
  assert.equal(env1.values['providers.openai-compatible.endpoint'], 'https://env1.example.com/v1');
  assert.equal(env1.sources['providers.openai-compatible.endpoint'], 'environment');

  // Environment alias QUIZZER_OPENAI_COMPATIBLE_BASE_URL
  const env2 = resolveSettings({
    user: { 'providers.openai-compatible.endpoint': 'https://jsonc.example.com/v1' },
    environment: { QUIZZER_OPENAI_COMPATIBLE_BASE_URL: 'https://env2.example.com/v1' },
  });
  assert.equal(env2.values['providers.openai-compatible.endpoint'], 'https://env2.example.com/v1');

  // Environment alias QUIZZER_OPENAI_COMPATIBLE_BASE_ENDPOINT
  const env3 = resolveSettings({
    user: { 'providers.openai-compatible.endpoint': 'https://jsonc.example.com/v1' },
    environment: { QUIZZER_OPENAI_COMPATIBLE_BASE_ENDPOINT: 'https://env3.example.com/v1' },
  });
  assert.equal(env3.values['providers.openai-compatible.endpoint'], 'https://env3.example.com/v1');

  // CLI override beats environment and user
  const cli = resolveSettings({
    user: { 'providers.openai-compatible.endpoint': 'https://jsonc.example.com/v1' },
    environment: { QUIZZER_OPENAI_COMPATIBLE_ENDPOINT: 'https://env1.example.com/v1' },
    cli: { 'providers.openai-compatible.endpoint': 'https://cli.example.com/v1' },
  });
  assert.equal(cli.values['providers.openai-compatible.endpoint'], 'https://cli.example.com/v1');
  assert.equal(cli.sources['providers.openai-compatible.endpoint'], 'cli');

  // Job override beats CLI
  const job = resolveSettings({
    user: { 'providers.openai-compatible.endpoint': 'https://jsonc.example.com/v1' },
    environment: { QUIZZER_OPENAI_COMPATIBLE_ENDPOINT: 'https://env1.example.com/v1' },
    cli: { 'providers.openai-compatible.endpoint': 'https://cli.example.com/v1' },
    job: { 'providers.openai-compatible.endpoint': 'http://127.0.0.1:11434/v1' },
  });
  assert.equal(job.values['providers.openai-compatible.endpoint'], 'http://127.0.0.1:11434/v1');
  assert.equal(job.sources['providers.openai-compatible.endpoint'], 'job');
});

test('validates types, ranges, unknown settings, and secret-like keys', () => {
  assert.deepEqual(validateSettings({ 'extraction.ocr': true }), { 'extraction.ocr': true });
  assert.deepEqual(validateSettings({ 'embeddings.embedderPlugin': 'dev.quizzer.embedder' }), { 'embeddings.embedderPlugin': 'dev.quizzer.embedder' });
  assert.deepEqual(validateSettings({ 'extraction.extractorPlugin': 'dev.quizzer.extractor' }), { 'extraction.extractorPlugin': 'dev.quizzer.extractor' });
  assert.deepEqual(validateSettings({ 'retrieval.vectorIndexPlugin': 'dev.quizzer.vector' }), { 'retrieval.vectorIndexPlugin': 'dev.quizzer.vector' });
  assert.deepEqual(validateSettings({ 'retrieval.planning': 'multi-query' }), { 'retrieval.planning': 'multi-query' });
  assert.deepEqual(validateSettings({ 'retrieval.hydeModel': 'library/qwen3:4b' }), { 'retrieval.hydeModel': 'library/qwen3:4b' });
  assert.deepEqual(validateSettings({ 'providers.openai-compatible.endpoint': 'http://127.0.0.1:11434/v1' }), { 'providers.openai-compatible.endpoint': 'http://127.0.0.1:11434/v1' });
  assert.deepEqual(validateSettings({ 'providers.openai-compatible.endpoint': 'https://api.openai.com/v1' }), { 'providers.openai-compatible.endpoint': 'https://api.openai.com/v1' });
  assert.throws(() => validateSettings({ 'providers.openai-compatible.endpoint': 'http://api.openai.com/v1' }), /require HTTPS/i);
  assert.throws(() => validateSettings({ 'retrieval.hydeModel': '../remote' }), /invalid value/);
  assert.throws(() => validateSettings({ 'retrieval.planning': 'remote-model' }), /must be one of/);
  assert.throws(() => validateSettings({ 'generation.concurrency': 99 }), /from 1 to 10/);
  assert.throws(() => validateSettings({ 'providers.codex.maxConcurrency': 0 }), /from 1 to 10/);
  assert.throws(() => validateSettings({ 'unknown.value': true }), /Unknown setting/);
  assert.throws(() => validateSettings({ 'provider.apiKey': 'secret' }), /Secrets cannot be stored/);
  assert.equal(SETTINGS_SCHEMA.additionalProperties, false);
});

test('uses progressively stronger bounded query planning across hardware profiles', () => {
  const lite = resolveSettings({ profile: 'lite', environment: {} });
  const balanced = resolveSettings({ profile: 'balanced', environment: {} });
  const max = resolveSettings({ profile: 'max', environment: {} });
  assert.equal(lite.values['retrieval.planning'], 'none');
  assert.equal(balanced.values['retrieval.planning'], 'multi-query');
  assert.equal(max.values['retrieval.planning'], 'hyde');
  assert.equal(max.values['retrieval.hydeModel'], 'qwen3:4b');
  assert.equal(SETTINGS_SCHEMA.properties['retrieval.planning'].enum.join(','), 'none,multi-query,hyde');
  assert.match('qwen3:4b', new RegExp(SETTINGS_SCHEMA.properties['retrieval.hydeModel'].pattern));
  assert.equal(SETTINGS_SCHEMA.properties['retrieval.planning']['x-quizzer-reindex-required'], false);
});

test('persists validated user overrides and reads JSONC comments', async () => {
  await writeUserSettings(directory, { 'hardware.profile': 'max', 'extraction.ocr': false });
  const text = await readFile(join(directory, 'config.jsonc'), 'utf8');
  assert.doesNotMatch(text, /secret/i);
  assert.deepEqual(await readUserSettings(directory), { 'hardware.profile': 'max', 'extraction.ocr': false });

  await writeFile(join(directory, 'config.jsonc'), '// User overrides\n{ "hardware.profile": "max", /* keep OCR off */ "extraction.ocr": false }\n');

  const resolved = await loadResolvedSettings(directory, { environment: {} });
  assert.equal(resolved.profile, 'max');
  assert.equal(resolved.values['retrieval.contextBudget'], 16384);
  assert.equal(resolved.values['extraction.ocr'], false);
});
