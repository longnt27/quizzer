import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PROVIDER_POLICIES, providerConcurrencySettingKey } from './provider-policy.mjs';

const baseSettings = [
  {
    key: 'retrieval.planning', type: 'string', enum: ['none', 'multi-query', 'hyde'], default: 'none',
    title: 'Query planning', description: 'Uses bounded deterministic variants and, for HyDE, only an explicitly configured local callback.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_RETRIEVAL_PLANNING',
  },

  {
    key: 'interface.mode', type: 'string', enum: ['simple', 'advanced'], default: 'simple',
    title: 'Interface mode', description: 'Controls how many creation and settings controls are disclosed.',
    visibility: 'basic', resourceEffect: 'none', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_INTERFACE_MODE',
  },
  {
    key: 'hardware.profile', type: 'string', enum: ['lite', 'balanced', 'max'], default: 'lite',
    title: 'Hardware profile', description: 'Selects a safe baseline for extraction, retrieval, and local generation.',
    visibility: 'basic', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_HARDWARE_PROFILE',
  },
  {
    key: 'generation.concurrency', type: 'integer', minimum: 1, maximum: 10, default: 2,
    title: 'Generation concurrency', description: 'Maximum number of tests generated at the same time.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_GENERATION_CONCURRENCY',
  },
  {
    key: 'generation.batchSize', type: 'integer', minimum: 5, maximum: 25, default: 10,
    title: 'Generation batch size', description: 'Maximum number of requested questions in one provider call.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_GENERATION_BATCH_SIZE',
  },
  {
    key: 'generation.defaultProvider', type: 'string', default: 'codex',
    title: 'Default provider', description: 'Provider used when a job does not specify a route.',
    visibility: 'basic', resourceEffect: 'none', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_DEFAULT_PROVIDER',
  },
  {
    key: 'retrieval.mode', type: 'string', enum: ['sparse', 'hybrid'], default: 'sparse',
    title: 'Retrieval mode', description: 'Uses SQLite text search alone or combines it with dense retrieval.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_RETRIEVAL_MODE',
  },
  {
    key: 'retrieval.contextBudget', type: 'integer', minimum: 1024, maximum: 65536, default: 4096,
    title: 'Context budget', description: 'Maximum retrieved context tokens supplied to generation.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_CONTEXT_BUDGET',
  },
  {
    key: 'retrieval.rerank', type: 'boolean', default: false,
    title: 'Reranking', description: 'Reranks retrieved passages with the selected local component.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_RERANK',
  },
  {
    key: 'retrieval.rerankerPlugin', type: 'string', default: 'builtin',
    title: 'Reranker component', description: 'Uses Quizzer’s built-in local signals or an installed reranker plugin id.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_RERANKER_PLUGIN',
  },
  {
    key: 'retrieval.vectorIndexPlugin', type: 'string', default: 'builtin',
    title: 'Vector-index component', description: 'Uses Quizzer’s built-in LanceDB index or an installed vector-index plugin id.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_VECTOR_INDEX_PLUGIN',
  },
  {
    key: 'extraction.marker', type: 'boolean', default: false,
    title: 'Visual PDF extraction', description: 'Uses Marker when available for structured and visual PDFs.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_MARKER',
  },
  {
    key: 'extraction.extractorPlugin', type: 'string', default: 'builtin',
    title: 'Document extractor component', description: 'Uses Quizzer’s built-in extraction pipeline or an installed extractor plugin id.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_EXTRACTOR_PLUGIN',
  },
  {
    key: 'extraction.ocr', type: 'boolean', default: false,
    title: 'OCR', description: 'Runs OCR on document images when text extraction is insufficient.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_OCR',
  },
  {
    key: 'extraction.ocrPlugin', type: 'string', default: 'builtin',
    title: 'OCR component', description: 'Uses managed RapidOCR or an installed OCR plugin id.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_OCR_PLUGIN',
  },
  {
    key: 'embeddings.enabled', type: 'boolean', default: false,
    title: 'Dense embeddings', description: 'Maintains a rebuildable dense index in addition to sparse search.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_EMBEDDINGS',
  },
  {
    key: 'embeddings.model', type: 'string', default: 'all-minilm',
    title: 'Embedding model', description: 'Model name supplied to the selected local embedding component.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_EMBEDDING_MODEL',
  },
  {
    key: 'embeddings.embedderPlugin', type: 'string', default: 'builtin',
    title: 'Embedding component', description: 'Uses built-in Ollama embeddings or an installed embedder plugin id.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: true,
    environment: 'QUIZZER_EMBEDDER_PLUGIN',
  },
  {
    key: 'jobs.continueInBackground', type: 'boolean', default: true,
    title: 'Continue in background', description: 'Keeps active work running when the desktop window closes.',
    visibility: 'basic', resourceEffect: 'low', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_CONTINUE_IN_BACKGROUND',
  },
  {
    key: 'plugins.developerMode', type: 'boolean', default: false,
    title: 'Advanced Developer Mode', description: 'Allows unsigned local plugins and keeps a persistent security warning enabled.',
    visibility: 'advanced', resourceEffect: 'none', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_PLUGIN_DEVELOPER_MODE',
  },
];

const providerConcurrencySettings = Object.entries(PROVIDER_POLICIES).map(([provider, policy]) => ({
  key: providerConcurrencySettingKey(provider), type: 'integer', minimum: 1, maximum: 10, default: policy.defaultConcurrency,
  title: `${policy.label} concurrency`,
  description: `Maximum simultaneous generation jobs using ${policy.label}. This cap applies across every connected Quizzer window.`,
  visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
  environment: `QUIZZER_${provider.replaceAll('-', '_').toUpperCase()}_MAX_CONCURRENCY`,
}));

export const SETTINGS_REGISTRY = Object.freeze([...baseSettings, ...providerConcurrencySettings]);

const definitions = new Map(SETTINGS_REGISTRY.map(definition => [definition.key, definition]));
const secretName = /(api.?key|password|secret|token|credential)/i;

export const HARDWARE_PROFILE_SETTINGS = Object.freeze({
  lite: Object.freeze({
    'hardware.profile': 'lite',
    'retrieval.planning': 'none',
    'generation.concurrency': 1,
    'generation.batchSize': 10,
    'retrieval.mode': 'sparse',
    'retrieval.contextBudget': 4096,
    'retrieval.rerank': false,
    'retrieval.rerankerPlugin': 'builtin',
    'retrieval.vectorIndexPlugin': 'builtin',
    'extraction.marker': false,
    'extraction.extractorPlugin': 'builtin',
    'extraction.ocr': false,
    'extraction.ocrPlugin': 'builtin',
    'embeddings.enabled': false,
    'embeddings.model': 'all-minilm',
    'embeddings.embedderPlugin': 'builtin',
  }),
  balanced: Object.freeze({
    'hardware.profile': 'balanced',
    'retrieval.planning': 'multi-query',
    'generation.concurrency': 3,
    'generation.batchSize': 15,
    'retrieval.mode': 'hybrid',
    'retrieval.contextBudget': 8192,
    'retrieval.rerank': true,
    'retrieval.rerankerPlugin': 'builtin',
    'retrieval.vectorIndexPlugin': 'builtin',
    'extraction.marker': false,
    'extraction.extractorPlugin': 'builtin',
    'extraction.ocr': true,
    'extraction.ocrPlugin': 'builtin',
    'embeddings.enabled': true,
    'embeddings.model': 'all-minilm',
    'embeddings.embedderPlugin': 'builtin',
  }),
  max: Object.freeze({
    'hardware.profile': 'max',
    'retrieval.planning': 'hyde',
    'generation.concurrency': 5,
    'generation.batchSize': 20,
    'retrieval.mode': 'hybrid',
    'retrieval.contextBudget': 16384,
    'retrieval.rerank': true,
    'retrieval.rerankerPlugin': 'builtin',
    'retrieval.vectorIndexPlugin': 'builtin',
    'extraction.marker': true,
    'extraction.extractorPlugin': 'builtin',
    'extraction.ocr': true,
    'extraction.ocrPlugin': 'builtin',
    'embeddings.enabled': true,
    'embeddings.model': 'all-minilm',
    'embeddings.embedderPlugin': 'builtin',
  }),
});

const validateValue = (definition, value) => {
  if (definition.type === 'integer' && (!Number.isSafeInteger(value)
    || value < definition.minimum || value > definition.maximum)) {
    throw new Error(`${definition.key} must be an integer from ${definition.minimum} to ${definition.maximum}`);
  }
  if (definition.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${definition.key} must be true or false`);
  if (definition.type === 'string' && (typeof value !== 'string' || !value.trim())) throw new Error(`${definition.key} must be a non-empty string`);
  if (definition.enum && !definition.enum.includes(value)) throw new Error(`${definition.key} must be one of: ${definition.enum.join(', ')}`);
  return value;
};

export const validateSettings = (values, { partial = true } = {}) => {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Settings must be an object');
  const validated = {};
  for (const [key, value] of Object.entries(values)) {
    if (secretName.test(key)) throw new Error('Secrets cannot be stored in Quizzer settings');
    const definition = definitions.get(key);
    if (!definition) throw new Error(`Unknown setting: ${key}`);
    validated[key] = validateValue(definition, value);
  }
  if (!partial) {
    for (const definition of SETTINGS_REGISTRY) {
      if (!(definition.key in validated)) throw new Error(`Missing setting: ${definition.key}`);
    }
  }
  return validated;
};

const parseEnvironmentValue = (definition, value) => {
  if (definition.type === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(value)) return true;
    if (/^(0|false|no|off)$/i.test(value)) return false;
    throw new Error(`${definition.environment} must be true or false`);
  }
  if (definition.type === 'integer') return Number(value);
  return value;
};

const stripJsonComments = source => {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') { inString = true; output += current; continue; }
    if (current === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
};

export const settingsPath = appDataDirectory => join(appDataDirectory, 'config.jsonc');

export const readUserSettings = async appDataDirectory => {
  try {
    const source = await readFile(settingsPath(appDataDirectory), 'utf8');
    return validateSettings(JSON.parse(stripJsonComments(source)));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
};

export const writeUserSettings = async (appDataDirectory, values) => {
  const validated = validateSettings(values);
  const path = settingsPath(appDataDirectory);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  return validated;
};

const applyLayer = (values, sources, layer, source) => {
  for (const [key, value] of Object.entries(validateSettings(layer))) {
    values[key] = value;
    sources[key] = source;
  }
};

export const resolveSettings = ({
  profile = 'lite', user = {}, environment = process.env, cli = {}, job = {},
} = {}) => {
  const environmentValues = {};
  for (const definition of SETTINGS_REGISTRY) {
    const value = environment[definition.environment];
    if (typeof value === 'string' && value !== '') environmentValues[definition.key] = parseEnvironmentValue(definition, value);
  }
  const selectedProfile = job['hardware.profile'] ?? cli['hardware.profile']
    ?? environmentValues['hardware.profile'] ?? user['hardware.profile'] ?? profile;
  if (!(selectedProfile in HARDWARE_PROFILE_SETTINGS)) throw new Error(`Unknown hardware profile: ${selectedProfile}`);
  const values = Object.fromEntries(SETTINGS_REGISTRY.map(definition => [definition.key, definition.default]));
  const sources = Object.fromEntries(SETTINGS_REGISTRY.map(definition => [definition.key, 'default']));
  applyLayer(values, sources, HARDWARE_PROFILE_SETTINGS[selectedProfile], `profile:${selectedProfile}`);
  applyLayer(values, sources, user, 'user');
  applyLayer(values, sources, environmentValues, 'environment');
  applyLayer(values, sources, cli, 'cli');
  applyLayer(values, sources, job, 'job');
  return { profile: values['hardware.profile'], values, sources };
};

export const loadResolvedSettings = async (appDataDirectory, options = {}) => {
  const user = await readUserSettings(appDataDirectory);
  const requestedProfile = options.profile || user['hardware.profile'] || 'lite';
  return resolveSettings({ ...options, profile: requestedProfile, user });
};

export const SETTINGS_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://quizzer.dev/schemas/settings-v1.json',
  title: 'Quizzer settings',
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(SETTINGS_REGISTRY.map(definition => [definition.key, {
    type: definition.type,
    title: definition.title,
    description: definition.description,
    default: definition.default,
    ...(definition.enum ? { enum: definition.enum } : {}),
    ...(definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
    ...(definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
    'x-quizzer-visibility': definition.visibility,
    'x-quizzer-resource-effect': definition.resourceEffect,
    'x-quizzer-restart-required': definition.restartRequired,
    'x-quizzer-reindex-required': definition.reindexRequired,
    'x-quizzer-environment': definition.environment,
  }])),
});
