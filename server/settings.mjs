import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PROVIDER_POLICIES, providerConcurrencySettingKey } from './provider-policy.mjs';
import { validateOpenAICompatibleEndpoint } from './openai-compatible-generation.mjs';
import { validateLlamaCppEndpoint, validateLlamaCppModel, DEFAULT_LLAMA_CPP_ENDPOINT, DEFAULT_LLAMA_CPP_MODEL } from './llama-cpp-generation.mjs';

const baseSettings = [
  {
    key: 'retrieval.planning', type: 'string', enum: ['none', 'multi-query', 'hyde'], default: 'none',
    title: 'Query planning', description: 'Uses bounded deterministic variants and, for HyDE, an installed local Ollama model only.',
    visibility: 'advanced', resourceEffect: 'medium', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_RETRIEVAL_PLANNING',
  },
  {
    key: 'retrieval.hydeModel', type: 'string', default: 'qwen3:4b',
    pattern: '^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}/){0,4}[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$',
    title: 'Local HyDE model', description: 'Installed Ollama model used to write hypothetical retrieval passages. Quizzer never downloads it automatically or sends these requests remotely.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_HYDE_MODEL',
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
    pattern: '^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}/){0,4}[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$',
    title: 'Embedding model', description: 'Model name supplied to the selected local embedding component. Profiles choose a hardware-appropriate baseline.',
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
  {
    key: 'providers.openai-compatible.endpoint', type: 'string', default: 'https://api.openai.com/v1',
    title: 'OpenAI-compatible endpoint', description: 'Base URL for custom OpenAI-compatible chat completions (e.g. https://api.openai.com/v1 or http://127.0.0.1:8000/v1).',
    visibility: 'advanced', resourceEffect: 'none', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_OPENAI_COMPATIBLE_ENDPOINT',
  },
  {
    key: 'providers.llama-cpp.endpoint', type: 'string', default: DEFAULT_LLAMA_CPP_ENDPOINT,
    title: 'llama.cpp endpoint', description: 'Local llama.cpp server endpoint. Only unauthenticated HTTP loopback addresses are accepted; Quizzer never sends this route to a remote host.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_ENDPOINT',
  },
  {
    key: 'providers.llama-cpp.model', type: 'string', default: DEFAULT_LLAMA_CPP_MODEL,
    title: 'llama.cpp model', description: 'Model identifier served by the configured local llama.cpp server. Quizzer does not download models automatically.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_MODEL',
  },
  {
    key: 'providers.llama-cpp.executablePath', type: 'string', default: '', optional: true,
    title: 'Managed llama.cpp executable path', description: 'Absolute path to an already-installed llama.cpp server executable. Quizzer never searches PATH or downloads this binary.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: true, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_EXECUTABLE_PATH',
  },
  {
    key: 'providers.llama-cpp.modelPath', type: 'string', default: '', optional: true,
    title: 'Managed llama.cpp model path', description: 'Absolute path to an already-installed GGUF model file. Quizzer never downloads this model.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: false, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_MODEL_PATH',
  },
  {
    key: 'providers.llama-cpp.managedPort', type: 'integer', minimum: 1024, maximum: 65535, default: 8080,
    title: 'Managed llama.cpp port', description: 'Loopback port used by the explicitly selected llama.cpp process.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: true, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_MANAGED_PORT',
  },
  {
    key: 'providers.llama-cpp.contextSize', type: 'integer', minimum: 512, maximum: 131072, default: 4096,
    title: 'llama.cpp context size', description: 'Bounded context window passed to the managed llama.cpp process.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: true, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_CONTEXT_SIZE',
  },
  {
    key: 'providers.llama-cpp.batchSize', type: 'integer', minimum: 1, maximum: 2048, default: 512,
    title: 'llama.cpp batch size', description: 'Bounded prompt batch size passed to the managed llama.cpp process.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: true, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_BATCH_SIZE',
  },
  {
    key: 'providers.llama-cpp.threads', type: 'integer', minimum: 1, maximum: 256, default: 4,
    title: 'llama.cpp CPU threads', description: 'Upper bound for managed llama.cpp CPU threads; the runtime clamps it to detected CPU cores.',
    visibility: 'advanced', resourceEffect: 'high', restartRequired: true, reindexRequired: false,
    environment: 'QUIZZER_LLAMA_CPP_THREADS',
  },
];

const providerConcurrencySettings = Object.entries(PROVIDER_POLICIES).filter(([, policy]) => policy.configurableConcurrency !== false).map(([provider, policy]) => ({
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
    'retrieval.hydeModel': 'qwen3:4b',
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
    'retrieval.hydeModel': 'qwen3:4b',
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
    'retrieval.hydeModel': 'qwen3:4b',
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
    'embeddings.model': 'bge-m3',
    'embeddings.embedderPlugin': 'builtin',
  }),
});

const validateValue = (definition, value) => {
  if (definition.type === 'integer' && (!Number.isSafeInteger(value)
    || value < definition.minimum || value > definition.maximum)) {
    throw new Error(`${definition.key} must be an integer from ${definition.minimum} to ${definition.maximum}`);
  }
  if (definition.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${definition.key} must be true or false`);
  if (definition.type === 'string' && (typeof value !== 'string' || (!value.trim() && !definition.optional))) throw new Error(`${definition.key} must be a non-empty string`);
  if (definition.pattern && typeof value === 'string' && !new RegExp(definition.pattern, 'u').test(value.trim())) {
    throw new Error(`${definition.key} has an invalid value`);
  }
  if (definition.enum && !definition.enum.includes(value)) throw new Error(`${definition.key} must be one of: ${definition.enum.join(', ')}`);
  if (definition.key === 'providers.openai-compatible.endpoint') {
    validateOpenAICompatibleEndpoint(value);
  }
  if (definition.key === 'providers.llama-cpp.endpoint') validateLlamaCppEndpoint(value);
  if (definition.key === 'providers.llama-cpp.model') validateLlamaCppModel(value);
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
    const value = environment[definition.environment]
      ?? (definition.key === 'providers.openai-compatible.endpoint'
        ? (environment.QUIZZER_OPENAI_COMPATIBLE_BASE_URL || environment.QUIZZER_OPENAI_COMPATIBLE_BASE_ENDPOINT)
        : undefined);
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
    ...(definition.pattern ? { pattern: definition.pattern } : {}),
    ...(definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
    ...(definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
    'x-quizzer-visibility': definition.visibility,
    'x-quizzer-resource-effect': definition.resourceEffect,
    'x-quizzer-restart-required': definition.restartRequired,
    'x-quizzer-reindex-required': definition.reindexRequired,
    'x-quizzer-environment': definition.environment,
  }])),
});
