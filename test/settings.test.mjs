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
  assert.equal(resolved.values['extraction.extractorPlugin'], 'builtin');
  assert.equal(resolved.values['extraction.ocrPlugin'], 'builtin');
  assert.equal(resolved.values['retrieval.contextBudget'], 5000);
  assert.equal(resolved.values['generation.concurrency'], 6);
  assert.equal(resolved.sources['generation.concurrency'], 'job');
  assert.equal(resolved.values['providers.openai.maxConcurrency'], 4);
  assert.equal(resolved.sources['providers.openai.maxConcurrency'], 'environment');
  assert.equal(providerConcurrencyLimits(resolved.values).openai, 4);
  assert.deepEqual(publicProviderPolicies(resolved.values).openai, {
    billing: 'usage-based', privacy: 'remote-api', maxConcurrency: 4,
  });
});

test('validates types, ranges, unknown settings, and secret-like keys', () => {
  assert.deepEqual(validateSettings({ 'extraction.ocr': true }), { 'extraction.ocr': true });
  assert.deepEqual(validateSettings({ 'embeddings.embedderPlugin': 'dev.quizzer.embedder' }), { 'embeddings.embedderPlugin': 'dev.quizzer.embedder' });
  assert.deepEqual(validateSettings({ 'extraction.extractorPlugin': 'dev.quizzer.extractor' }), { 'extraction.extractorPlugin': 'dev.quizzer.extractor' });
  assert.throws(() => validateSettings({ 'generation.concurrency': 99 }), /from 1 to 10/);
  assert.throws(() => validateSettings({ 'providers.codex.maxConcurrency': 0 }), /from 1 to 10/);
  assert.throws(() => validateSettings({ 'unknown.value': true }), /Unknown setting/);
  assert.throws(() => validateSettings({ 'provider.apiKey': 'secret' }), /Secrets cannot be stored/);
  assert.equal(SETTINGS_SCHEMA.additionalProperties, false);
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
