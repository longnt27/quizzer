#!/usr/bin/env node
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureServiceToken } from '../server/auth.mjs';
import { importDocumentFile, reextractDocument } from '../server/document-import.mjs';
import { detectHardwareCapabilities } from '../server/hardware-profile.mjs';
import { databasePathFor, defaultAppDataDirectory, denseIndexPathFor, sparseIndexPathFor } from '../server/paths.mjs';
import { PluginManager } from '../plugin-sdk/manager.mjs';
import {
  loadResolvedSettings, readUserSettings, SETTINGS_REGISTRY, settingsPath, validateSettings, writeUserSettings,
} from '../server/settings.mjs';
import { RetrievalIndex } from '../server/retrieval-index.mjs';
import { readRuntimeText, runningAsSingleExecutable } from '../server/runtime-assets.mjs';
import { canonicalizeManifest } from '../release/manifest.mjs';
import { validateReleaseManifest } from '../server/release-manifest.mjs';
import { ObjectStore } from '../server/object-store.mjs';
import { createBackup, restoreBackup, verifyBackup } from '../server/backup.mjs';
import { cancelIndexJob, createIndexJob, recoverIndexJob, resumeIndexJob, runIndexJob } from '../server/index-jobs.mjs';
import { PROVIDER_POLICIES } from '../server/provider-policy.mjs';
import { resolveDocumentExtractor, resolveOcrProvider } from '../server/plugin-extraction.mjs';
import { resolveEmbeddingProvider } from '../server/plugin-embeddings.mjs';
import { resolveVectorIndexProvider } from '../server/plugin-vector-index.mjs';
import { runOllamaHyde } from '../server/ollama-generation.mjs';
import { validateOpenAICompatibleEndpoint } from '../server/openai-compatible-generation.mjs';
import { getKnownProviderRouteMetadata } from '../server/provider-pricing.mjs';

const usage = `Quizzer CLI

Usage:
  quizzer doctor [--json]
  quizzer serve [--port 8787]
  quizzer config list|get <key>|set <key> <value>|unset <key>|path [--json]
  quizzer plugins list [--registry]|install <directory|id> [--yes]|update <id> [--yes]
                  |enable <id>|disable <id>|health <id>|rollback <id>|remove <id> --yes [--json]
  quizzer documents list|show <id>|import <file> [--tags a,b]|reextract <id>|remove <id> --yes [--json]
  quizzer index <document-id>|--all [--force] [--idempotency-key key] [--json]
  quizzer retrieve <query> [--document <id>] [--tag <tag>] [--limit 10] [--json]
  quizzer test create --document <id> [--document <id>] [--name name] [--questions 20]
                      [--instruction text] [--provider provider] [--model model] [--endpoint url] [--approve-paid]
                      [--cost-ceiling USD|unlimited] [--input-price USD/1M] [--output-price USD/1M] [--json]
  quizzer jobs list|show <id>|cancel <id>|raise-ceiling <id> --cost-ceiling USD --reason text --confirm-cost [--resume] [--json]
  quizzer jobs approve-recovery <id> --reason text --confirm-cost [--resume] [--json]
  quizzer jobs resume <id> [--provider provider] [--model model] [--endpoint url] [--approve-paid] [--json]
  quizzer resume <job-id> [--provider provider] [--model model] [--endpoint url] [--approve-paid] [--json]
  quizzer migrations list [--json]
  quizzer backup create [--destination directory] [--json]
  quizzer backup verify <directory> [--json]
  quizzer backup restore <directory> --yes [--json]
  quizzer release verify --metadata <file> --signature <file> --public-key <file> [--json]
  quizzer version
`;

const parseArguments = arguments_ => {
  const positionals = [];
  const flags = new Map();
  const booleanFlags = new Set(['all', 'approve-paid', 'confirm-cost', 'force', 'help', 'json', 'registry', 'resume', 'yes']);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) { positionals.push(argument); continue; }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals >= 0 ? equals : undefined);
    let value = equals >= 0 ? argument.slice(equals + 1) : 'true';
    if (equals < 0 && !booleanFlags.has(name) && arguments_[index + 1] && !arguments_[index + 1].startsWith('--')) value = arguments_[++index];
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positionals, flags };
};

const parsed = parseArguments(process.argv.slice(2));
const jsonOutput = parsed.flags.has('json');
const appDataDirectory = defaultAppDataDirectory();
process.env.QUIZZER_APP_DATA_DIR = appDataDirectory;
process.env.QUIZZER_DATABASE_PATH ||= databasePathFor(appDataDirectory);
const objectStore = new ObjectStore(appDataDirectory);
const sparseIndexPath = process.env.QUIZZER_SPARSE_INDEX_PATH || sparseIndexPathFor(appDataDirectory);
const denseIndexPath = process.env.QUIZZER_DENSE_INDEX_PATH || denseIndexPathFor(appDataDirectory);
const createRetrievalIndex = () => new RetrievalIndex({
  sparsePath: sparseIndexPath,
  densePath: denseIndexPath,
  loadSettings: () => loadResolvedSettings(appDataDirectory),
  resolveEmbedding: settings => resolveEmbeddingProvider(settings, {
    loadManager: async () => new PluginManager({
      appDataDirectory,
      developerMode: settings.values['plugins.developerMode'],
    }),
  }),
  resolveVectorIndex: (settings, { builtin }) => resolveVectorIndexProvider(settings, {
    builtin,
    loadManager: async () => new PluginManager({
      appDataDirectory,
      developerMode: settings.values['plugins.developerMode'],
    }),
  }),
  invokeReranker: async (id, params, options) => {
    const settings = await loadResolvedSettings(appDataDirectory);
    const manager = new PluginManager({
      appDataDirectory,
      developerMode: settings.values['plugins.developerMode'],
    });
    const plugin = (await manager.list()).find(item => item.id === id);
    if (!plugin || plugin.status !== 'installed' || !plugin.enabled || !plugin.compatible || !plugin.capabilities?.includes('reranker')) {
      throw new Error(`Reranker plugin ${id} is not installed, enabled, and compatible`);
    }
    return (await manager.invoke(id, 'rag.rerank', params, options)).result;
  },
  invokeLocalHyde: async (query, options) => {
    if (options?.localOnly !== true) throw new Error('HyDE generation requires local-only routing');
    const settings = await loadResolvedSettings(appDataDirectory);
    return runOllamaHyde({ query, model: settings.values['retrieval.hydeModel'] }, options.signal);
  },
  onDenseIssue: issue => process.stderr.write(`Dense indexing unavailable; sparse retrieval remains ready: ${issue.message}\n`),
});

const flag = (name, fallback) => parsed.flags.get(name)?.at(-1) ?? fallback;
const flags = name => parsed.flags.get(name) ?? [];
const writeResult = (value, human) => {
  if (jsonOutput || human === undefined) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${human}\n`);
};
const fail = message => { throw new Error(message); };
const parseCostCeiling = raw => {
  if (raw === undefined || raw === null || String(raw).trim().toLowerCase() === 'unlimited') return undefined;
  const value = String(raw).trim().replace(/^\$/, '');
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) fail('--cost-ceiling must be a non-negative USD amount (for example 1.50) or unlimited');
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) fail('--cost-ceiling is too large');
  return Number(micros);
};
const parsePricePerMillion = (raw, flagName) => {
  if (raw === undefined) return undefined;
  const value = String(raw).trim().replace(/^\$/, '');
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) fail(`${flagName} must be a non-negative USD amount per million tokens`);
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${flagName} is too large`);
  return Number(micros);
};
const routeMetadata = (provider, model, finiteCeiling) => {
  const known = getKnownProviderRouteMetadata(provider, model);
  const input = parsePricePerMillion(flag('input-price', undefined), '--input-price');
  const output = parsePricePerMillion(flag('output-price', undefined), '--output-price');
  if ((input === undefined) !== (output === undefined)) fail('--input-price and --output-price must be provided together');
  if (input !== undefined) known.pricing = { inputMicroUsdPerMillionTokens: input, outputMicroUsdPerMillionTokens: output };
  if (finiteCeiling !== undefined && known.pricing === undefined) {
    fail('A finite --cost-ceiling requires known model pricing or both --input-price and --output-price');
  }
  return known;
};
const providerPolicy = provider => PROVIDER_POLICIES[provider] ?? fail(`Unsupported provider: ${provider}`);
const requirePaidApproval = (provider, policy) => {
  if (policy.billing === 'usage-based' && flag('approve-paid') !== 'true') {
    fail(`${provider} is a usage-based remote API route. Re-run with --approve-paid to confirm possible charges and provider data handling.`);
  }
};

let storageModule;
let embeddedSqliteReady;
const ensureEmbeddedSqlite = async () => {
  if (!runningAsSingleExecutable) return;
  embeddedSqliteReady ??= import('./sea-better-sqlite3.mjs').then(module => module.initializeEmbeddedSqlite());
  await embeddedSqliteReady;
};
const storage = async () => {
  await ensureEmbeddedSqlite();
  storageModule ??= await import('../server/storage.mjs');
  return storageModule;
};

const serviceRequest = async (path, init = {}) => {
  const token = await ensureServiceToken(appDataDirectory);
  const base = process.env.QUIZZER_SERVICE_URL || 'http://127.0.0.1:8787';
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Quizzer service returned ${response.status}`);
  return payload;
};

const parseSettingValue = (key, raw) => {
  const definition = SETTINGS_REGISTRY.find(item => item.key === key);
  if (!definition) fail(`Unknown setting: ${key}`);
  if (definition.type === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(raw)) return true;
    if (/^(false|0|no|off)$/i.test(raw)) return false;
    fail(`${key} must be true or false`);
  }
  if (definition.type === 'integer') return Number(raw);
  return raw;
};

const runConfig = async action => {
  if (action === 'path') return writeResult({ path: settingsPath(appDataDirectory) }, settingsPath(appDataDirectory));
  const current = await readUserSettings(appDataDirectory);
  if (action === 'list') {
    const resolved = await loadResolvedSettings(appDataDirectory);
    const rows = SETTINGS_REGISTRY.map(item => ({ key: item.key, value: resolved.values[item.key], source: resolved.sources[item.key] }));
    return writeResult({ profile: resolved.profile, settings: rows }, rows.map(row => `${row.key}=${JSON.stringify(row.value)} (${row.source})`).join('\n'));
  }
  const key = parsed.positionals.shift();
  if (!key) fail(`config ${action} requires a setting name`);
  if (action === 'get') {
    const resolved = await loadResolvedSettings(appDataDirectory);
    if (!(key in resolved.values)) fail(`Unknown setting: ${key}`);
    return writeResult({ key, value: resolved.values[key], source: resolved.sources[key] }, String(resolved.values[key]));
  }
  if (action === 'set') {
    const raw = parsed.positionals.shift();
    if (raw === undefined) fail('config set requires a value');
    const next = { ...current, [key]: parseSettingValue(key, raw) };
    validateSettings(next);
    await writeUserSettings(appDataDirectory, next);
    return writeResult({ key, value: next[key] }, `Saved ${key}=${JSON.stringify(next[key])}`);
  }
  if (action === 'unset') {
    validateSettings({ [key]: SETTINGS_REGISTRY.find(item => item.key === key)?.default });
    delete current[key];
    await writeUserSettings(appDataDirectory, current);
    return writeResult({ key, removed: true }, `Reset ${key} to its profile/default value`);
  }
  fail('Use config list, get, set, unset, or path');
};

const runDoctor = async () => {
  const hardware = detectHardwareCapabilities(appDataDirectory);
  const settings = await loadResolvedSettings(appDataDirectory);
  let service = { reachable: false };
  try { service = { reachable: true, ...await serviceRequest('/api/v1/health') }; }
  catch (error) { service = { reachable: false, error: error instanceof Error ? error.message : String(error) }; }
  const report = {
    ok: true,
    appDataDirectory,
    databasePath: process.env.QUIZZER_DATABASE_PATH,
    sparseIndexPath,
    denseIndexPath,
    service,
    hardware,
    settings: { profile: settings.profile, values: settings.values },
  };
  writeResult(report, [
    `App data: ${report.appDataDirectory}`,
    `Database: ${report.databasePath}`,
    `Sparse index: ${report.sparseIndexPath}`,
    `Dense index: ${report.denseIndexPath}`,
    `Service: ${service.reachable ? 'ready' : 'not running'}`,
    `Hardware: ${hardware.architecture}, ${hardware.cpuCores} cores, ${hardware.memoryGB} GB RAM`,
    `Recommended profile: ${hardware.recommendedProfile}`,
    `Configured profile: ${settings.profile}`,
  ].join('\n'));
};

const runPlugins = async action => {
  const settings = await loadResolvedSettings(appDataDirectory);
  const manager = new PluginManager({
    appDataDirectory,
    developerMode: settings.values['plugins.developerMode'],
  });
  if (action === 'list') {
    if (flag('registry') === 'true') {
      const plugins = await manager.listRegistry();
      return writeResult({ plugins }, plugins.length
        ? plugins.map(plugin => `${plugin.id}  v${plugin.version}  ${plugin.name}${plugin.installed ? (plugin.updateAvailable ? ' (update available)' : ' (installed)') : ' (available)'}`).join('\n')
        : 'No registry plugins available');
    }
    const plugins = await manager.list();
    return writeResult({ plugins }, plugins.length
      ? plugins.map(plugin => `${plugin.id}  ${plugin.version ?? '-'}  ${plugin.enabled ? 'enabled' : plugin.status}${plugin.updateAvailable ? ' (update available)' : ''}  [${plugin.source ?? 'local'}]`).join('\n')
      : 'No external plugins installed');
  }
  const target = parsed.positionals.shift();
  if (!target) fail(`plugins ${action} requires ${action === 'install' ? 'a directory or plugin id' : 'a plugin id'}`);
  if (action === 'install') {
    const plugin = await manager.install(target, { confirmed: flag('yes') === 'true' });
    return writeResult({ plugin }, `Installed ${plugin.name} ${plugin.version}${plugin.warning ? `\nWarning: ${plugin.warning}` : ''}`);
  }
  if (action === 'update') {
    const result = await manager.update(target, { confirmed: flag('yes') === 'true' });
    if (result.updated === false) {
      return writeResult(result, result.message || `${target} is already up to date`);
    }
    return writeResult({ plugin: result }, `Updated ${result.name} to ${result.version}`);
  }
  if (action === 'enable' || action === 'disable') {
    const plugin = await manager.setEnabled(target, action === 'enable');
    return writeResult({ plugin }, `${action === 'enable' ? 'Enabled' : 'Disabled'} ${plugin.name}`);
  }
  if (action === 'health') {
    const health = await manager.health(target);
    return writeResult({ id: target, health }, health.ok ? `${target} is healthy (${health.durationMs} ms)` : `${target} failed: ${health.error}`);
  }
  if (action === 'rollback') {
    const plugin = await manager.rollback(target);
    return writeResult({ plugin }, `Rolled ${target} back to ${plugin.version}; review and enable it when ready`);
  }
  if (action === 'remove') {
    if (flag('yes') !== 'true') fail('plugins remove requires --yes');
    const result = await manager.remove(target);
    return writeResult(result, `Removed ${target}. Recovery copy: ${result.recoveryPath}`);
  }
  fail('Use plugins list, install, update, enable, disable, health, rollback, or remove');
};

const loadCliExtractionOptions = async () => {
  const settings = await loadResolvedSettings(appDataDirectory);
  const loadManager = async () => new PluginManager({
    appDataDirectory,
    developerMode: settings.values['plugins.developerMode'],
  });
  const extractor = await resolveDocumentExtractor(settings, { loadManager });
  const ocr = settings.values['extraction.ocr']
    ? await resolveOcrProvider(settings, { loadManager })
    : { ocr: undefined };
  return { extractor: extractor.extract, ocr: ocr.ocr };
};

const runDocuments = async action => {
  const database = await storage();
  if (action === 'list') {
    const documents = database.listRecords('documents').map(record => ({
      id: record.id, name: record.data.name, size: record.data.size, tags: record.data.tags ?? [],
      chunks: record.data.chunks?.length ?? 0, createdAt: record.data.createdAt,
    }));
    return writeResult({ documents }, documents.length ? documents.map(item => `${item.id}  ${item.name}  ${item.chunks} chunks`).join('\n') : 'No documents');
  }
  if (action === 'import') {
    const path = parsed.positionals.shift();
    if (!path) fail('documents import requires a file path');
    const extraction = await loadCliExtractionOptions();
    const document = await importDocumentFile(path, {
      tags: String(flag('tags', '')).split(','), objectStore, ...extraction,
    });
    const duplicate = database.listRecords('documents').find(record => record.data.contentHash === document.contentHash);
    if (duplicate) return writeResult({ imported: false, duplicateOf: duplicate.id, document: duplicate.data }, `Already imported as ${duplicate.data.name} (${duplicate.id})`);
    database.putRecord('documents', document.id, document);
    return writeResult({ imported: true, document }, `Imported ${document.name} (${document.id}) with ${document.chunks.length} chunks`);
  }
  const id = parsed.positionals.shift();
  if (!id) fail(`documents ${action} requires a document id`);
  const record = database.getRecord('documents', id);
  if (!record) fail(`Document not found: ${id}`);
  if (action === 'show') {
    const document = { ...record.data, originalFile: undefined };
    return writeResult({ document }, `${document.name}\n${document.mimeType} · ${document.size} bytes · ${document.chunks?.length ?? 0} chunks\n\n${document.content.slice(0, 800)}`);
  }
  if (action === 'reextract') {
    const extracted = await reextractDocument(record.data, { objectStore, ...await loadCliExtractionOptions() });
    const saved = database.putRecord('documents', id, extracted);
    const index = createRetrievalIndex();
    try { await index.removeDocument(id); }
    finally { await index.close(); }
    const indexJob = createIndexJob({ documentIds: [id], force: true });
    database.putRecord('indexJobs', indexJob.id, indexJob);
    await executeStoredIndexJob(database, indexJob);
    const document = database.getRecord('documents', id).data;
    return writeResult(
      { document, job: database.getRecord('indexJobs', indexJob.id).data },
      `Re-extracted ${saved.data.name} with ${document.parserVersion} and rebuilt ${document.chunks.length} indexed spans`,
    );
  }
  if (action === 'remove') {
    if (flag('yes') !== 'true') fail('documents remove requires --yes');
    database.deleteRecord('documents', id);
    const index = createRetrievalIndex();
    try { await index.removeDocument(id); }
    finally { await index.close(); }
    return writeResult({ removed: id }, `Removed ${record.data.name}`);
  }
  fail('Use documents list, show, import, reextract, or remove');
};

const executeStoredIndexJob = async (database, job) => {
  const index = createRetrievalIndex();
  try {
    return await runIndexJob(job, {
      load: id => database.getRecord('indexJobs', id)?.data,
      save: next => database.putRecord('indexJobs', next.id, next).data,
      getDocument: id => database.getRecord('documents', id),
      indexDocument: (record, options) => index.indexDocument(record, options),
      updateDocument: (record, result) => {
        if (!result.reused || (result.dense?.status === 'ready' && !result.dense.reused)) database.putRecord('documents', record.id, {
          ...record.data,
          indexedAt: Date.now(),
          indexVersion: 3,
          documentVersionHash: result.versionHash,
          denseIndex: result.dense?.status === 'ready' ? {
            model: result.dense.embeddingModel,
            dimension: result.dense.dimension,
            versionHash: result.dense.versionHash,
          } : record.data.denseIndex,
        });
      },
      yieldControl: () => new Promise(resolve => setImmediate(resolve)),
    });
  } finally {
    await index.close();
  }
};

const writeIndexJob = job => writeResult(
  { job, indexed: job.results },
  job.status === 'completed'
    ? job.results.map(item => `${item.name}: ${item.chunks} chunks${item.reused ? ' (unchanged)' : ''}`).join('\n')
    : `Index job ${job.id} is ${job.status}`,
);

const runIndex = async () => {
  const database = await storage();
  const selected = flag('all') === 'true'
    ? database.listRecords('documents')
    : [database.getRecord('documents', parsed.positionals.shift())].filter(Boolean);
  if (!selected.length) fail('No matching documents to index');
  const documentIds = selected.map(record => record.id);
  const idempotencyKey = flag('idempotency-key');
  const force = flag('force') === 'true';
  const existing = idempotencyKey
    ? database.listRecords('indexJobs').find(record => record.data.idempotencyKey === idempotencyKey)
    : undefined;
  let job;
  if (existing) {
    if (existing.data.force !== force || JSON.stringify(existing.data.documentIds) !== JSON.stringify(documentIds)) {
      fail('Index idempotency key was already used with a different request');
    }
    const recovered = recoverIndexJob(existing.data);
    job = ['failed', 'cancelled'].includes(recovered.status) ? resumeIndexJob(recovered) : recovered;
  } else {
    job = createIndexJob({ documentIds, force, idempotencyKey });
  }
  database.putRecord('indexJobs', job.id, job);
  if (job.status === 'completed') return writeIndexJob(job);
  try {
    return writeIndexJob(await executeStoredIndexJob(database, job));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Resume with: quizzer resume ${job.id}`);
  }
};

const runRetrieve = async () => {
  const query = parsed.positionals.join(' ').trim();
  if (!query) fail('retrieve requires a search query');
  const database = await storage();
  const documentIds = flags('document').flatMap(value => value.split(',')).filter(Boolean);
  const selected = documentIds.length
    ? documentIds.map(id => database.getRecord('documents', id)).filter(Boolean)
    : database.listRecords('documents');
  if (!selected.length) fail('No matching documents are available for retrieval');
  const index = createRetrievalIndex();
  try {
    let indexingError;
    for (const record of selected) {
      if (indexingError) index.indexSparseDocument(record);
      else {
        try { await index.indexDocument(record); }
        catch (error) { indexingError = error instanceof Error ? error.message : String(error); }
      }
    }
    const retrieval = await index.retrieve({
      query,
      documentIds,
      tags: flags('tag'),
      limit: Number(flag('limit', '10')),
    });
    if (indexingError) retrieval.indexingError = indexingError;
    const planning = retrieval.planningTrace;
    const planningSummary = planning
      ? `Query planning: ${planning.mode} · ${planning.variants.length} bounded variant${planning.variants.length === 1 ? '' : 's'}${planning.fallback ? ` · fallback: ${planning.reason}` : ''}`
      : 'Query planning: unavailable';
    const evidence = retrieval.results.length
      ? retrieval.results.map(result => `${result.documentName}${result.page ? ` p.${result.page}` : ''}  ${result.sourceSpanId}\n${result.excerpt}`).join('\n\n')
      : retrieval.refusal;
    writeResult(retrieval, `${planningSummary}\n\n${evidence}`);
  } finally {
    await index.close();
  }
};

const runTestCreate = async () => {
  const database = await storage();
  const documentIds = flags('document').flatMap(value => value.split(',')).filter(Boolean);
  if (!documentIds.length) fail('test create requires at least one --document id');
  for (const id of documentIds) if (!database.getRecord('documents', id)) fail(`Document not found: ${id}`);
  const questionCount = Number(flag('questions', '20'));
  if (!Number.isSafeInteger(questionCount) || questionCount < 1 || questionCount > 200) fail('--questions must be an integer from 1 to 200');
  const explicitEndpoint = flag('endpoint', flag('base-endpoint', undefined));
  if (explicitEndpoint) validateOpenAICompatibleEndpoint(explicitEndpoint);
  const cliOverrides = {
    ...(explicitEndpoint ? { 'providers.openai-compatible.endpoint': explicitEndpoint } : {}),
  };
  const settings = await loadResolvedSettings(appDataDirectory, { cli: cliOverrides });
  const provider = flag('provider', settings.values['generation.defaultProvider']);
  if (explicitEndpoint && provider !== 'openai-compatible') {
    fail('--endpoint and --base-endpoint require --provider openai-compatible');
  }
  const policy = providerPolicy(provider);
  requirePaidApproval(provider, policy);
  const model = flag('model', undefined);
  if (provider === 'openai-compatible' && (!model || !model.trim())) {
    fail('--model is required for openai-compatible');
  }
  const now = Date.now();
  const jobId = randomUUID();
  const name = flag('name', `Quiz ${new Date(now).toLocaleDateString()}`);
  const customInstruction = flag('instruction', undefined);
  const costCeilingMicroUsd = parseCostCeiling(flag('cost-ceiling', undefined));
  const metadata = routeMetadata(provider, model, costCeilingMicroUsd);
  const privacy = policy.privacy;
  const job = {
    id: jobId,
    testId: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    documentIds,
    options: {
      provider,
      ...(model ? { model } : {}),
      questionCount,
      ...(costCeilingMicroUsd === undefined ? {} : { costCeilingMicroUsd }),
      ...(customInstruction ? { customInstruction } : {}),
      ragProfile: {
        id: settings.profile,
        retrieval: settings.values['retrieval.mode'],
        contextBudget: settings.values['retrieval.contextBudget'],
        rerank: settings.values['retrieval.rerank'],
      },
      routeChain: [{ provider, ...(model ? { model } : {}), privacy, paid: privacy === 'remote-api', approved: true, ...metadata }],
      resolvedSettings: settings.values,
    },
    questions: [],
    rejected: 0,
    rounds: {},
  };
  const created = database.createGenerationJobs([job])[0].data;
  writeResult({ job: created }, `Queued ${name} (${job.id}). Open Quizzer to process it.`);
};

const runJobs = async (action, explicitId) => {
  const database = await storage();
  if (action === 'list') {
    const jobs = [
      ...database.listRecords('generationJobs').map(record => ({ ...record.data, kind: 'generation', accounting: database.getGenerationAccounting(record.id) })),
      ...database.listRecords('indexJobs').map(record => record.data),
    ].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return writeResult({ jobs }, jobs.length ? jobs.map(job => `${job.id}  ${job.status}  ${job.kind === 'index' ? `Index ${job.documentIds.length} document(s)` : job.name}`).join('\n') : 'No jobs');
  }
  const id = explicitId || parsed.positionals.shift();
  if (!id) fail(`jobs ${action} requires a job id`);
  const generationRecord = database.getRecord('generationJobs', id);
  const indexRecord = generationRecord ? undefined : database.getRecord('indexJobs', id);
  const record = generationRecord ?? indexRecord;
  if (!record) fail(`Job not found: ${id}`);
  if (action === 'raise-ceiling') {
    const newCeilingMicroUsd = parseCostCeiling(flag('cost-ceiling', undefined));
    if (newCeilingMicroUsd === undefined) fail('jobs raise-ceiling requires a finite --cost-ceiling');
    const reason = flag('reason', undefined);
    if (!reason) fail('jobs raise-ceiling requires --reason');
    if (flag('confirm-cost') !== 'true') fail('Raising a cost ceiling requires explicit confirmation. Re-run with --confirm-cost.');
    const raised = database.raiseGenerationCostCeiling(id, { newCeilingMicroUsd, reason, confirmed: true });
    if (flag('resume') === 'true') {
      const resumed = database.controlGenerationJob(id, 'resume', { resetRounds: false }).data;
      return writeResult({ job: resumed, accounting: database.getGenerationAccounting(id) }, `Raised ceiling and queued ${resumed.name}`);
    }
    return writeResult({ job: raised.data, accounting: database.getGenerationAccounting(id) }, `Raised ceiling for ${raised.data.name}`);
  }
  if (action === 'approve-recovery') {
    const reason = flag('reason', undefined);
    if (!reason) fail('jobs approve-recovery requires --reason');
    if (flag('confirm-cost') !== 'true') fail('Approving cost recovery requires explicit confirmation. Re-run with --confirm-cost.');
    const approved = database.approveGenerationCostRecovery(id, { reason, confirmed: true });
    if (flag('resume') === 'true') {
      const resumed = database.controlGenerationJob(id, 'resume', { resetRounds: false }).data;
      return writeResult({ job: resumed, accounting: database.getGenerationAccounting(id) }, `Approved recovery and queued ${resumed.name}`);
    }
    return writeResult({ job: approved.data, accounting: database.getGenerationAccounting(id) }, `Approved recovery for ${approved.data.name}`);
  }
  if (action === 'show') return writeResult(
    { job: record.data, ...(generationRecord ? { accounting: database.getGenerationAccounting(id) } : {}) },
    indexRecord
      ? `Index ${record.data.documentIds.length} document(s)\nStatus: ${record.data.status}\nCompleted: ${record.data.completedDocumentIds.length}`
      : `${record.data.name}\nStatus: ${record.data.status}\nAccepted: ${record.data.questions?.length ?? 0}`,
  );
  if (action !== 'resume' && action !== 'cancel') fail('Use jobs list, show, resume, cancel, or raise-ceiling');
  if (indexRecord) {
    if (action === 'cancel') {
      const job = cancelIndexJob(indexRecord.data);
      database.putRecord('indexJobs', id, job);
      return writeResult({ job }, `Cancelled index job ${id}`);
    }
    const recovered = recoverIndexJob(indexRecord.data);
    const resumable = recovered.status === 'queued' ? recovered : resumeIndexJob(recovered);
    database.putRecord('indexJobs', id, resumable);
    try {
      return writeIndexJob(await executeStoredIndexJob(database, resumable));
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Resume with: quizzer resume ${id}`);
    }
  }
  let changes = {};
  if (action === 'resume') {
    const selectedProvider = flag('provider');
    const requestedModel = flag('model');
    const explicitEndpoint = flag('endpoint', flag('base-endpoint', undefined));
    if (requestedModel && !selectedProvider) fail('--model requires --provider when resuming a generation job');
    if (explicitEndpoint && selectedProvider !== 'openai-compatible') {
      fail('--endpoint and --base-endpoint require --provider openai-compatible when resuming a generation job');
    }
    if (selectedProvider) {
      const policy = providerPolicy(selectedProvider);
      requirePaidApproval(selectedProvider, policy);
      const selectedModel = requestedModel ?? (selectedProvider === generationRecord.data.options.provider
        ? generationRecord.data.options.model
        : undefined);
      if (selectedProvider === 'openai-compatible' && (!selectedModel || !selectedModel.trim())) {
        fail('--model is required when resuming with openai-compatible');
      }
      if (explicitEndpoint) validateOpenAICompatibleEndpoint(explicitEndpoint);
      const selectedRoute = {
        provider: selectedProvider,
        ...(selectedModel ? { model: selectedModel } : {}),
        privacy: policy.privacy,
        paid: policy.billing === 'usage-based',
        approved: true,
        ...routeMetadata(selectedProvider, selectedModel, generationRecord.data.options.costCeilingMicroUsd),
      };
      const existingRoutes = generationRecord.data.options.routeChain;
      if (existingRoutes?.length) {
        const existingIndex = existingRoutes.findIndex(route => route.provider === selectedRoute.provider
          && (route.model ?? undefined) === (selectedRoute.model ?? undefined));
        const routeChain = existingIndex >= 0
          ? existingRoutes.map((route, index) => index === existingIndex ? { ...route, approved: true } : route)
          : [...existingRoutes, selectedRoute];
        const activeRouteIndex = existingIndex >= 0 ? existingIndex : routeChain.length - 1;
        const options = {
          ...generationRecord.data.options,
          provider: selectedProvider,
          model: selectedModel,
          routeChain,
          resolvedSettings: {
            ...(generationRecord.data.options.resolvedSettings ?? {}),
            ...(explicitEndpoint ? { 'providers.openai-compatible.endpoint': explicitEndpoint } : {}),
          },
        };
        const providerAttempts = [...(generationRecord.data.providerAttempts ?? []), {
          provider: selectedProvider,
          ...(selectedModel ? { model: selectedModel } : {}),
          routeIndex: activeRouteIndex,
          at: Date.now(),
          accepted: generationRecord.data.questions?.length ?? 0,
          outcome: 'manually-selected',
        }];
        changes = { options, activeRouteIndex, providerAttempts, resetRounds: false };
      } else {
        const options = {
          ...generationRecord.data.options,
          provider: selectedProvider,
          ...(selectedModel ? { model: selectedModel } : {}),
          routeChain: [selectedRoute],
          resolvedSettings: {
            ...(generationRecord.data.options.resolvedSettings ?? {}),
            ...(explicitEndpoint ? { 'providers.openai-compatible.endpoint': explicitEndpoint } : {}),
          },
        };
        changes = {
          options,
          activeRouteIndex: 0,
          providerAttempts: [...(generationRecord.data.providerAttempts ?? []), {
            provider: selectedProvider,
            ...(selectedModel ? { model: selectedModel } : {}),
            routeIndex: 0,
            at: Date.now(),
            accepted: generationRecord.data.questions?.length ?? 0,
            outcome: 'manually-selected',
          }],
          resetRounds: false,
        };
      }
    } else {
      if (flag('approve-paid') === 'true') fail('--approve-paid requires --provider when resuming a generation job');
      changes = { resetRounds: false };
    }
  }
  const job = database.controlGenerationJob(id, action, changes).data;
  writeResult({ job }, `${action === 'resume' ? 'Queued' : 'Cancelled'} ${job.name}`);
};

const runBackup = async action => {
  if (action === 'verify') {
    const directory = parsed.positionals.shift();
    if (!directory) fail('backup verify requires a backup directory');
    const result = await verifyBackup(directory);
    return writeResult(result, `Backup is valid: ${directory}\n${result.manifest.objects.length} objects · ${result.manifest.totals.objectBytes} bytes`);
  }
  if (action === 'restore') {
    const directory = parsed.positionals.shift();
    if (!directory) fail('backup restore requires a backup directory');
    if (flag('yes') !== 'true') fail('backup restore replaces the current library and requires --yes');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(`http://127.0.0.1:${process.env.QUIZZER_SERVICE_PORT || 8787}/api/health`, { signal: controller.signal });
      if (response.ok && (await response.json().catch(() => ({}))).ok === true) {
        fail('Quit the Quizzer desktop app and stop the local service before restoring a backup');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('stop the local service')) throw error;
    } finally { clearTimeout(timer); }

    await verifyBackup(directory);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recoveryDirectory = join(appDataDirectory, 'backups', `before-restore-${stamp}`);
    const database = await storage();
    await createBackup({
      destination: recoveryDirectory,
      database,
      objectStore,
      settingsFile: settingsPath(appDataDirectory),
    });
    database.closeDatabase();
    const result = await restoreBackup({
      directory,
      appDataDirectory,
      databasePath: process.env.QUIZZER_DATABASE_PATH,
      settingsFile: settingsPath(appDataDirectory),
    });
    return writeResult(
      { ...result, directory, recoveryDirectory },
      `Backup restored from ${directory}\nPrevious library recovery copy: ${recoveryDirectory}`,
    );
  }
  if (action !== 'create') fail('Use backup create, verify, or restore');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = flag('destination', join(appDataDirectory, 'backups', stamp));
  const manifest = await createBackup({
    destination: directory,
    database: await storage(),
    objectStore,
    settingsFile: settingsPath(appDataDirectory),
  });
  writeResult({ directory, manifest }, `Backup created at ${directory}\n${manifest.objects.length} objects · ${manifest.totals.objectBytes} bytes`);
};

const runMigrations = async action => {
  if (action !== 'list') fail('Use migrations list');
  const database = await storage();
  const migrations = database.listLegacyMigrations();
  return writeResult({ migrations }, migrations.length
    ? migrations.map(item => `${item.id}  ${item.status}  ${item.receivedRecords}/${item.expectedRecords}\n  rollback: ${item.backupPath}`).join('\n')
    : 'No legacy migrations have run');
};

const runRelease = async action => {
  if (action !== 'verify') fail('Use release verify');
  const metadataPath = flag('metadata');
  const signaturePath = flag('signature');
  const publicKeyPath = flag('public-key');
  if (!metadataPath || !signaturePath || !publicKeyPath) {
    fail('release verify requires --metadata, --signature, and --public-key');
  }
  const [metadataBytes, signature, publicKeyPem] = await Promise.all([
    readFile(metadataPath), readFile(signaturePath), readFile(publicKeyPath, 'utf8'),
  ]);
  const metadataText = metadataBytes.toString('utf8');
  const metadata = JSON.parse(metadataText);
  const signedManifest = { ...metadata, signature: signature.toString('base64url') };
  const validation = validateReleaseManifest(signedManifest);
  if (!validation.valid) fail(`Release metadata is invalid: ${validation.errors.join('; ')}`);
  if (canonicalizeManifest(signedManifest) !== metadataText) fail('Release metadata is not canonical');
  if (!verify(null, metadataBytes, createPublicKey(publicKeyPem), signature)) fail('Release signature is invalid');
  return writeResult(
    { valid: true, version: metadata.version, publicKeyId: metadata.publicKeyId, artifacts: metadata.artifacts.length },
    `Verified Quizzer ${metadata.version} (${metadata.artifacts.length} artifacts)`,
  );
};

const main = async () => {
  const command = parsed.positionals.shift();
  if (!command || command === 'help' || flag('help') === 'true') return process.stdout.write(usage);
  if (command === 'version') {
    const packageJson = JSON.parse(await readRuntimeText('package.json', new URL('../package.json', import.meta.url)));
    return process.stdout.write(`${packageJson.version}\n`);
  }
  if (command === 'serve') {
    const port = Number(flag('port', '8787'));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('--port must be a valid TCP port');
    process.env.QUIZZER_SERVICE_PORT = String(port);
    await ensureEmbeddedSqlite();
    await import('../server.mjs');
    return;
  }
  if (command === 'doctor') return runDoctor();
  if (command === 'config') return runConfig(parsed.positionals.shift() || 'list');
  if (command === 'plugins') return runPlugins(parsed.positionals.shift() || 'list');
  if (command === 'documents') return runDocuments(parsed.positionals.shift() || 'list');
  if (command === 'index') return runIndex();
  if (command === 'retrieve') return runRetrieve();
  if (command === 'test') {
    if (parsed.positionals.shift() !== 'create') fail('Use test create');
    return runTestCreate();
  }
  if (command === 'jobs') return runJobs(parsed.positionals.shift() || 'list');
  if (command === 'resume') return runJobs('resume', parsed.positionals.shift());
  if (command === 'migrations') return runMigrations(parsed.positionals.shift() || 'list');
  if (command === 'backup') return runBackup(parsed.positionals.shift() || 'create');
  if (command === 'release') return runRelease(parsed.positionals.shift() || 'verify');
  fail(`Unknown command: ${command}\n\n${usage}`);
};

main().catch(error => {
  process.stderr.write(`quizzer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
