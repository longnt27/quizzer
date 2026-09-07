import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  approveGenerationCostRecovery, backupDatabase, beginLegacyMigration, claimGenerationJob, completeGenerationJob, controlGenerationJob, createGenerationJobs, deleteRecord, finalizeGenerationAttempt, finalizeLegacyMigration, getGenerationAccounting, getRecord, listLegacyMigrations,
  listRecords, putRecord, raiseGenerationCostCeiling, renewGenerationJobLease, reserveGenerationAttempt, storageInfo, subscribeStorageChanges, syncStorage, updateGenerationJobWithLease,
} from './server/storage.mjs';
import { detectHardwareCapabilities } from './server/hardware-profile.mjs';
import { ensureServiceToken, isAuthorizedRequest } from './server/auth.mjs';
import {
  HARDWARE_PROFILE_SETTINGS, loadResolvedSettings, readUserSettings, SETTINGS_REGISTRY, SETTINGS_SCHEMA, settingsPath, validateSettings, writeUserSettings,
} from './server/settings.mjs';
import { validateOnboardingState } from './server/onboarding.mjs';
import { PluginManager } from './plugin-sdk/manager.mjs';
import { materializeRuntimeAsset, readRuntimeText, runningAsSingleExecutable } from './server/runtime-assets.mjs';
import { collectStoredObjectReferences, materializeDocumentImages, materializeSerializedObjects, ObjectStore } from './server/object-store.mjs';
import { defaultAppDataDirectory, denseIndexPathFor, sparseIndexPathFor } from './server/paths.mjs';
import { createBackup, listBackups, verifyBackup } from './server/backup.mjs';
import { cancelIndexJob, createIndexJob, recoverIndexJob, resumeIndexJob, runIndexJob } from './server/index-jobs.mjs';
import { extractDocumentBuffer, reextractDocument } from './server/document-import.mjs';
import { PROVIDER_POLICIES, providerConcurrencyLimits, publicProviderPolicies } from './server/provider-policy.mjs';
import { RetrievalIndex } from './server/retrieval-index.mjs';
import { bindRequestCancellation } from './server/request-lifetime.mjs';
import { ProviderCredentialStore } from './server/provider-credentials.mjs';
import { GenerationJobWorker } from './server/generation-worker.mjs';
import { runGeneratorPlugin } from './server/plugin-generation.mjs';
import { resolveEmbeddingProvider } from './server/plugin-embeddings.mjs';
import { resolveVectorIndexProvider } from './server/plugin-vector-index.mjs';
import { resolveDocumentExtractor, resolveOcrProvider } from './server/plugin-extraction.mjs';
import { listOllamaModels, ollamaModelMatches, runOllamaGeneration, runOllamaHyde, validateOllamaModelName } from './server/ollama-generation.mjs';
import {
  getLlamaCppStatus, runLlamaCppGeneration, validateLlamaCppEndpoint, validateLlamaCppModel,
} from './server/llama-cpp-generation.mjs';
import { createLlamaCppRuntime } from './server/llama-cpp-runtime.mjs';
import { runOpenAICompatibleGeneration } from './server/openai-compatible-generation.mjs';
import { normalizeProviderUsage } from './server/provider-usage.mjs';
import {
  runAnthropic as runBuiltinAnthropic, runGemini as runBuiltinGemini,
  runOpenAI as runBuiltinOpenAI, runOpenAICompatible as runBuiltinOpenAICompatible,
} from './server/builtin-provider-generation.mjs';

const configuredPortValue = process.env.QUIZZER_SERVICE_PORT ?? '8787';
const configuredPort = Number(configuredPortValue);
if (!/^\d{1,5}$/.test(configuredPortValue) || !Number.isSafeInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
  throw new Error('QUIZZER_SERVICE_PORT must be an integer from 0 to 65535');
}
const maxBodyBytes = 25 * 1024 * 1024;
const maxStorageBodyBytes = 250 * 1024 * 1024;
const appDataDirectory = defaultAppDataDirectory();
const resourceDirectory = process.env.QUIZZER_RESOURCE_DIR || process.cwd();
const managedMarkerDirectory = join(appDataDirectory, '.quizzer-tools', 'marker');
const managedMarkerExecutable = join(managedMarkerDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'marker_single.exe' : 'marker_single');
const managedOcrDirectory = join(appDataDirectory, '.quizzer-tools', 'ocr');
const managedOcrPython = join(managedOcrDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const serviceToken = await ensureServiceToken(appDataDirectory);
const providerCredentials = new ProviderCredentialStore();
process.parentPort?.on?.('message', event => {
  const message = event?.data ?? event;
  if (message?.type !== 'quizzer-provider-credentials') return;
  try { providerCredentials.replace(message.values); }
  catch (error) {
    process.stderr.write(`Credential handoff rejected: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
const ocrScript = process.env.QUIZZER_OCR_SCRIPT || (runningAsSingleExecutable
  ? await materializeRuntimeAsset('scripts/ocr_image.py', join(appDataDirectory, 'runtime', 'ocr_image.py'))
  : join(resourceDirectory, 'scripts', 'ocr_image.py'));
const openApiDocument = await readRuntimeText('openapi/quizzer-v1.yaml', new URL('./openapi/quizzer-v1.yaml', import.meta.url));
const pluginManifestSchema = JSON.parse(await readRuntimeText('plugin-sdk/quizzer.plugin.schema.json', new URL('./plugin-sdk/quizzer.plugin.schema.json', import.meta.url)));
const builtInPlugins = Object.freeze([
  { id: 'quizzer.extract.basic', name: 'Basic PDF.js and text extraction', capabilities: ['extractor'], builtIn: true },
  { id: 'quizzer.extract.marker', name: 'Marker visual extraction', capabilities: ['extractor'], builtIn: true },
  { id: 'quizzer.ocr.rapidocr', name: 'RapidOCR', capabilities: ['ocr'], builtIn: true },
  { id: 'quizzer.index.fts5', name: 'SQLite FTS5 and BM25', capabilities: ['sparse-search'], builtIn: true },
  { id: 'quizzer.index.lancedb', name: 'LanceDB vector index', capabilities: ['vector-index'], builtIn: true },
  { id: 'quizzer.embed.minilm', name: 'MiniLM through Ollama', capabilities: ['embedder', 'reranker'], builtIn: true },
  { id: 'quizzer.generate.providers', name: 'Local agents and API providers', capabilities: ['generator'], builtIn: true },
]);
const objectStore = new ObjectStore(appDataDirectory);
const manualBackupRoot = join(appDataDirectory, 'backups', 'manual');
for (const record of listRecords('documents')) {
  try {
    const binaryMaterialized = await materializeSerializedObjects(record.data, objectStore);
    const migrated = await materializeDocumentImages(binaryMaterialized, objectStore);
    if (migrated.changed || JSON.stringify(binaryMaterialized) !== JSON.stringify(record.data)) {
      putRecord('documents', record.id, migrated.document);
    }
  } catch (error) {
    process.stderr.write(`Could not migrate binary assets for ${record.id}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
const referencedObjectIds = () => collectStoredObjectReferences(listRecords('documents').map(record => record.data));
const pruneUnreferencedObjects = (minimumAgeMs = 24 * 60 * 60 * 1000) => objectStore.garbageCollect(
  referencedObjectIds(), { minimumAgeMs },
);
await pruneUnreferencedObjects();
setInterval(() => void pruneUnreferencedObjects().catch(error => {
  process.stderr.write(`Object cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
}), 6 * 60 * 60 * 1000).unref();
const retrievalIndex = new RetrievalIndex({
  sparsePath: process.env.QUIZZER_SPARSE_INDEX_PATH || sparseIndexPathFor(appDataDirectory),
  densePath: process.env.QUIZZER_DENSE_INDEX_PATH || denseIndexPathFor(appDataDirectory),
  loadSettings: () => loadResolvedSettings(appDataDirectory),
  resolveEmbedding: settings => resolveEmbeddingProvider(settings, { loadManager: getPluginManager }),
  resolveVectorIndex: (settings, { builtin }) => resolveVectorIndexProvider(settings, {
    loadManager: getPluginManager, builtin,
  }),
  invokeReranker: async (id, params, options) => {
    const manager = await getPluginManager();
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
  onDenseIssue: (issue, record) => process.stderr.write(
    `Dense indexing unavailable for ${record.id}; sparse retrieval remains ready: ${issue.message}\n`,
  ),
});
const activeIndexExecutions = new Map();
const loadIndexJob = id => getRecord('indexJobs', id)?.data;
const saveIndexJob = job => putRecord('indexJobs', job.id, job).data;
const reportIndexFailure = (id, error) => {
  process.stderr.write(`Index job ${id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
};
const executeIndexJob = id => {
  const active = activeIndexExecutions.get(id);
  if (active) return active;
  const job = loadIndexJob(id);
  if (!job) return Promise.reject(new Error('Index job not found'));
  const execution = runIndexJob(job, {
    load: loadIndexJob,
    save: saveIndexJob,
    getDocument: documentId => getRecord('documents', documentId),
    indexDocument: (record, options) => retrievalIndex.indexDocument(record, options),
    updateDocument: (record, result) => {
      if (!result.reused || (result.dense?.status === 'ready' && !result.dense.reused)) putRecord('documents', record.id, {
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
  }).finally(() => activeIndexExecutions.delete(id));
  activeIndexExecutions.set(id, execution);
  return execution;
};

const selectIndexDocuments = documentIds => {
  if (documentIds !== undefined && (!Array.isArray(documentIds) || documentIds.some(id => typeof id !== 'string'))) {
    throw new Error('documentIds must be an array of ids');
  }
  const ids = documentIds?.length ? [...new Set(documentIds)] : listRecords('documents').map(record => record.id);
  const selected = ids.map(id => getRecord('documents', id));
  const missing = ids.filter((_id, index) => !selected[index]);
  if (missing.length) throw new Error(`Documents not found: ${missing.join(', ')}`);
  if (!selected.length) throw new Error('No matching documents to index');
  return selected;
};

const prepareIndexJob = ({ records, force = false, idempotencyKey }) => {
  const documentIds = records.map(record => record.id);
  const existing = idempotencyKey
    ? listRecords('indexJobs').find(record => record.data.idempotencyKey === idempotencyKey)
    : undefined;
  if (existing) {
    if (existing.data.force !== force || JSON.stringify(existing.data.documentIds) !== JSON.stringify(documentIds)) {
      throw new Error('Index idempotency key was already used with a different request');
    }
    if (existing.data.status === 'failed' || existing.data.status === 'cancelled') {
      return putRecord('indexJobs', existing.id, resumeIndexJob(existing.data));
    }
    return existing;
  }
  const job = createIndexJob({ documentIds, force, idempotencyKey });
  return putRecord('indexJobs', job.id, job);
};

const retrievalDocumentFingerprint = record => createHash('sha256').update(JSON.stringify({
  id: record.id,
  contentHash: record.data.contentHash || createHash('sha256').update(record.data.content).digest('hex'),
  parserVersion: record.data.parserVersion || 'unknown',
  extractionContentHash: record.data.extractionContentHash || createHash('sha256').update(record.data.content).digest('hex'),
  length: record.data.content.length,
})).digest('hex');

setImmediate(() => {
  for (const record of listRecords('indexJobs')) {
    if (record.data.status !== 'queued' && record.data.status !== 'running') continue;
    try {
      const recovered = recoverIndexJob(record.data);
      if (recovered !== record.data) saveIndexJob(recovered);
      void executeIndexJob(record.id).catch(error => reportIndexFailure(record.id, error));
    } catch (error) {
      reportIndexFailure(record.id, error);
    }
  }
});
const windowsOllamaExecutable = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
  : 'ollama.exe';
const integrationJobs = {
  marker: { state: 'idle', message: '' },
  codex: { state: 'idle', message: '' },
  'claude-agent': { state: 'idle', message: '' },
  'antigravity-agent': { state: 'idle', message: '' },
  ollama: { state: 'idle', message: '' },
  'llama-cpp': { state: 'idle', message: '' },
  embeddings: { state: 'idle', message: '' },
  ocr: { state: 'idle', message: '' },
};
let systemMarkerDetected;
let managedMarkerDetected;
let managedOcrDetected;

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:5173' });
  response.end(JSON.stringify(body));
};

const sendStoredObject = async (request, response, sha256) => {
  let details;
  try { details = await objectStore.stat(sha256); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      send(response, 404, { error: 'Stored object not found' });
      return;
    }
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': details.size,
    'Cache-Control': 'private, immutable, max-age=31536000',
    'Access-Control-Allow-Origin': 'http://localhost:5173',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = objectStore.createReadStream(sha256);
    stream.once('error', reject);
    response.once('finish', resolve);
    response.once('close', resolve);
    stream.pipe(response);
  });
};

const publicRecord = record => ({ ...record.data, id: record.id, revision: record.revision, updatedAt: record.updatedAt });

const documentSummary = record => ({
  id: record.id,
  revision: record.revision,
  updatedAt: record.updatedAt,
  name: record.data.name,
  createdAt: record.data.createdAt,
  mimeType: record.data.mimeType,
  size: record.data.size,
  tags: record.data.tags ?? [],
  pageCount: record.data.pageCount,
  chunkCount: Array.isArray(record.data.chunks) ? record.data.chunks.length : 0,
  parserVersion: record.data.parserVersion,
  extractionSchemaVersion: record.data.extractionSchemaVersion,
  extractedAt: record.data.extractedAt,
});

const updateUserSettings = async body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Settings update must be an object');
  const current = await readUserSettings(appDataDirectory);
  const patch = validateSettings(body.values ?? {});
  const unset = body.unset ?? [];
  if (!Array.isArray(unset) || unset.some(key => typeof key !== 'string')) throw new Error('unset must be an array of setting names');
  for (const key of unset) {
    validateSettings({ [key]: SETTINGS_REGISTRY.find(definition => definition.key === key)?.default });
    delete current[key];
  }
  return writeUserSettings(appDataDirectory, { ...current, ...patch });
};

const configureLlamaCpp = async body => {
  if (body?.confirmed !== true) throw new Error('Explicit confirmation is required before configuring llama.cpp');
  const endpoint = validateLlamaCppEndpoint(body?.endpoint);
  const model = validateLlamaCppModel(body?.model);
  const current = await readUserSettings(appDataDirectory);
  await writeUserSettings(appDataDirectory, {
    ...current,
    'providers.llama-cpp.endpoint': endpoint,
    'providers.llama-cpp.model': model,
  });
  return { ok: true, settings: await loadResolvedSettings(appDataDirectory) };
};

const llamaCppRuntime = createLlamaCppRuntime({
  appDataDirectory,
  loadSettings: () => loadResolvedSettings(appDataDirectory),
  saveSettings: values => writeUserSettings(appDataDirectory, values),
  patchSettings: async values => {
    const current = await readUserSettings(appDataDirectory);
    return writeUserSettings(appDataDirectory, { ...current, ...values });
  },
  detectHardware: () => detectHardwareCapabilities(appDataDirectory),
});
await llamaCppRuntime.initialize();

const getPluginManager = async () => {
  const settings = await loadResolvedSettings(appDataDirectory);
  return new PluginManager({
    appDataDirectory,
    developerMode: settings.values['plugins.developerMode'],
  });
};

const sendStorageEvents = (request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ revision: storageInfo().revision })}\n\n`);
  const unsubscribe = subscribeStorageChanges(changes => {
    if (!response.destroyed) response.write(`event: storage\ndata: ${JSON.stringify({ changes })}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(': keepalive\n\n');
  }, 15_000);
  const close = () => { clearInterval(heartbeat); unsubscribe(); };
  request.once('close', close);
  response.once('close', close);
};

const readJson = (request, limit = maxBodyBytes) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let failed = false;
  request.on('data', chunk => {
    if (failed) return;
    size += chunk.length;
    if (size > limit) {
      failed = true;
      reject(new Error('Request is too large'));
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (failed) return;
    try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
    catch { reject(new Error('Invalid JSON request')); }
  });
  request.on('error', reject);
});

const decodeImage = (dataUrl, index) => {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Invalid image input');
  const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
  return { path: `source-${index}.${extension}`, data: Buffer.from(match[2], 'base64') };
};

const cancellationError = () => Object.assign(new Error('Generation cancelled'), { name: 'AbortError' });

const stripTerminalCodes = value => value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/\r/g, '').trim();

const runCommand = (command, args, { timeout = 20_000, onOutput, signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : cancellationError());
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let output = '';
  let failure;
  const append = chunk => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
    onOutput?.(stripTerminalCodes(output));
  };
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  };
  const abort = () => {
    failure = signal?.reason instanceof Error ? signal.reason : cancellationError();
    child.kill('SIGTERM');
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', error => { cleanup(); reject(error); });
  const timer = setTimeout(() => {
    failure = new Error(`${command} timed out after ${timeout} ms`);
    child.kill('SIGTERM');
  }, timeout);
  signal?.addEventListener('abort', abort, { once: true });
  child.on('close', code => {
    cleanup();
    const cleanOutput = stripTerminalCodes(output);
    if (failure) reject(failure);
    else if (code === 0) resolve(cleanOutput);
    else reject(new Error(cleanOutput || `${command} exited with code ${code}`));
  });
});

const commandWorks = async (command, args, timeout = 10_000) => {
  try { await runCommand(command, args, { timeout }); return true; }
  catch { return false; }
};

const managedMarkerExists = async () => {
  try { await access(managedMarkerExecutable); return true; }
  catch { return false; }
};

const managedMarkerWorks = async () => {
  if (managedMarkerDetected === undefined) managedMarkerDetected = await managedMarkerExists()
    && await commandWorks(managedMarkerExecutable, ['--help'], 30_000);
  return managedMarkerDetected;
};

const markerCommand = async () => await managedMarkerWorks() ? managedMarkerExecutable : 'marker_single';

const ollamaCommand = async () => {
  if (process.platform === 'win32') {
    try { await access(windowsOllamaExecutable); return windowsOllamaExecutable; }
    catch { /* Fall through to PATH lookup. */ }
  }
  return 'ollama';
};

const hasSystemMarker = async () => {
  if (systemMarkerDetected === undefined) systemMarkerDetected = await commandWorks('marker_single', ['--help'], 15_000);
  return systemMarkerDetected;
};

const compatiblePython = async () => {
  const candidates = process.platform === 'win32'
    ? [{ command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] }]
    : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'].map(command => ({ command, prefix: [] }));
  for (const candidate of candidates) {
    if (await commandWorks(candidate.command, [...candidate.prefix, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'])) return candidate;
  }
  throw new Error('Managed PDF and OCR plugins require Python 3.10 or newer. Install a current Python version, then retry.');
};

const managedOcrWorks = async () => {
  if (managedOcrDetected === undefined) managedOcrDetected = await commandWorks(
    managedOcrPython, ['-c', 'import rapidocr, onnxruntime'], 30_000,
  );
  return managedOcrDetected;
};

const integrationStatus = async () => {
  const ollamaExecutable = await ollamaCommand();
  const settings = await loadResolvedSettings(appDataDirectory);
  const runtime = await llamaCppRuntime.getStatus();
  const llamaEndpoint = runtime.state === 'running' ? llamaCppRuntime.endpointFor({ host: '127.0.0.1', port: runtime.port }) : settings.values['providers.llama-cpp.endpoint'];
  const [codexInstalled, codexConnected, claudeInstalled, claudeConnected, antigravityInstalled, ollamaInstalled, ollama, llamaCpp, managedMarker, systemMarker, managedOcr] = await Promise.all([
    commandWorks('codex', ['--version']),
    commandWorks('codex', ['login', 'status']),
    commandWorks('claude', ['--version']),
    commandWorks('claude', ['auth', 'status']),
    commandWorks('agy', ['--version']),
    commandWorks(ollamaExecutable, ['--version']),
    listOllamaModels(globalThis.fetch, AbortSignal.timeout(3_000)).catch(() => ({ serverReady: false, models: [] })),
    getLlamaCppStatus({ endpoint: llamaEndpoint }, globalThis.fetch, AbortSignal.timeout(3_500)),
    managedMarkerWorks(),
    hasSystemMarker(),
    managedOcrWorks(),
  ]);
  const embeddingModel = settings.values['embeddings.model'];
  return {
    marker: { installed: managedMarker || systemMarker, managed: managedMarker, job: integrationJobs.marker },
    codex: { installed: codexInstalled, connected: codexConnected, job: integrationJobs.codex },
    'claude-agent': { installed: claudeInstalled, connected: claudeConnected, job: integrationJobs['claude-agent'] },
    'antigravity-agent': {
      installed: antigravityInstalled,
      connected: integrationJobs['antigravity-agent'].state === 'complete',
      job: integrationJobs['antigravity-agent'],
    },
    gemini: { available: true },
    anthropic: { available: true },
    openai: { available: true },
    openrouter: { available: true },
    deepseek: { available: true },
    'openai-compatible': { available: true },
    'llama-cpp': { ...llamaCpp, runtime },
    ollama: {
      installed: ollamaInstalled || ollama.serverReady,
      serverReady: ollama.serverReady,
      models: ollama.models,
      job: integrationJobs.ollama,
    },
    embeddings: {
      installed: ollama.models.some(model => ollamaModelMatches(model.name, embeddingModel)),
      runtimeInstalled: ollamaInstalled || ollama.serverReady,
      model: embeddingModel,
      job: integrationJobs.embeddings,
    },
    ocr: { installed: managedOcr, managed: managedOcr, job: integrationJobs.ocr },
  };
};

const installMarker = () => {
  if (integrationJobs.marker.state === 'working') return;
  integrationJobs.marker = { state: 'working', message: 'Creating Quizzer’s private Python environment…' };
  void (async () => {
    try {
      const python = await compatiblePython();
      await rm(managedMarkerDirectory, { recursive: true, force: true });
      managedMarkerDetected = undefined;
      await runCommand(python.command, [...python.prefix, '-m', 'venv', managedMarkerDirectory], {
        timeout: 120_000,
        onOutput: output => { if (output) integrationJobs.marker.message = output; },
      });
      const pip = join(managedMarkerDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
      integrationJobs.marker.message = 'Downloading and installing Marker. This can take several minutes…';
      await runCommand(pip, ['install', '--upgrade', 'marker-pdf'], {
        timeout: 30 * 60_000,
        onOutput: output => { integrationJobs.marker.message = output || integrationJobs.marker.message; },
      });
      managedMarkerDetected = await commandWorks(managedMarkerExecutable, ['--help'], 60_000);
      if (!managedMarkerDetected) throw new Error('Marker installed but failed its startup check.');
      integrationJobs.marker = { state: 'complete', message: 'Marker is installed and ready.' };
    } catch (error) {
      integrationJobs.marker = { state: 'error', message: error instanceof Error ? error.message : 'Marker installation failed' };
    }
  })();
};

const installOcr = () => {
  if (integrationJobs.ocr.state === 'working') return;
  integrationJobs.ocr = { state: 'working', message: 'Creating Quizzer’s private OCR environment…' };
  void (async () => {
    const python = await compatiblePython();
    await rm(managedOcrDirectory, { recursive: true, force: true });
    managedOcrDetected = undefined;
    await runCommand(python.command, [...python.prefix, '-m', 'venv', managedOcrDirectory], {
      timeout: 120_000,
      onOutput: output => { if (output) integrationJobs.ocr.message = output; },
    });
    const pip = join(managedOcrDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
    integrationJobs.ocr.message = 'Downloading RapidOCR and its lightweight CPU runtime…';
    await runCommand(pip, ['install', '--upgrade', 'rapidocr', 'onnxruntime'], {
      timeout: 30 * 60_000,
      onOutput: output => { integrationJobs.ocr.message = output || integrationJobs.ocr.message; },
    });
    managedOcrDetected = await commandWorks(managedOcrPython, ['-c', 'import rapidocr, onnxruntime'], 60_000);
    if (!managedOcrDetected) throw new Error('OCR installed but failed its startup check.');
    integrationJobs.ocr = { state: 'complete', message: 'RapidOCR is installed and ready for extracted images.' };
  })().catch(error => {
    integrationJobs.ocr = { state: 'error', message: error instanceof Error ? error.message : 'OCR installation failed' };
  });
};

const runManagedOcr = async (path, signal) => {
  if (!await managedOcrWorks()) return '';
  const output = await runCommand(managedOcrPython, [ocrScript, path], { timeout: 90_000, signal });
  const marker = '__QUIZZER_OCR__';
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error('OCR returned an unreadable result.');
  const texts = JSON.parse(output.slice(markerIndex + marker.length).trim());
  return Array.isArray(texts) ? texts.filter(value => typeof value === 'string').join(' ') : '';
};

const runManagedOcrBuffer = async (data, { name = 'image.png', signal } = {}) => {
  if (!await managedOcrWorks()) return '';
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-ocr-'));
  const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-200) || 'image.png';
  const path = join(directory, safeName);
  try {
    await writeFile(path, data);
    return await runManagedOcr(path, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const connectCodex = () => {
  if (integrationJobs.codex.state === 'working') return;
  integrationJobs.codex = { state: 'working', message: 'Starting Codex device login…' };
  void runCommand('codex', ['login', '--device-auth'], {
    timeout: 15 * 60_000,
    onOutput: output => { integrationJobs.codex.message = output || integrationJobs.codex.message; },
  }).then(output => {
    integrationJobs.codex = { state: 'complete', message: output || 'Codex is connected.' };
  }).catch(error => {
    integrationJobs.codex = { state: 'error', message: error instanceof Error ? error.message : 'Codex login failed' };
  });
};

const connectAgent = (provider, command, args, startingMessage) => {
  if (integrationJobs[provider].state === 'working') return;
  integrationJobs[provider] = { state: 'working', message: startingMessage };
  void runCommand(command, args, {
    timeout: 15 * 60_000,
    onOutput: output => { integrationJobs[provider].message = output || integrationJobs[provider].message; },
  }).then(output => {
    integrationJobs[provider] = { state: 'complete', message: output || `${provider} is connected.` };
  }).catch(error => {
    integrationJobs[provider] = { state: 'error', message: error instanceof Error ? error.message : `${provider} login failed` };
  });
};

const connectClaude = () => connectAgent('claude-agent', 'claude', ['auth', 'login'], 'Starting Claude sign-in…');
const connectAntigravity = () => connectAgent(
  'antigravity-agent', 'agy', ['-p', '/model', '--output-format', 'json'], 'Starting Antigravity sign-in…',
);

const downloadAndRunScript = async (url, args, onOutput) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Installer download failed (${response.status})`);
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-installer-'));
  const path = join(directory, 'install.sh');
  try {
    await writeFile(path, await response.text(), { mode: 0o700 });
    return await runCommand('bash', [path, ...args], { timeout: 15 * 60_000, onOutput });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const downloadAndRunPowerShell = async (url, onOutput) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Installer download failed (${response.status})`);
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-installer-'));
  const path = join(directory, 'install.ps1');
  try {
    await writeFile(path, await response.text());
    return await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path], { timeout: 15 * 60_000, onOutput });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const installAgent = (provider, url) => {
  if (integrationJobs[provider].state === 'working') return;
  integrationJobs[provider] = { state: 'working', message: `Downloading the official ${provider === 'claude-agent' ? 'Claude' : 'Antigravity'} installer…` };
  void downloadAndRunScript(url, [], output => { integrationJobs[provider].message = output || integrationJobs[provider].message; })
    .then(output => { integrationJobs[provider] = { state: 'complete', message: output || 'Agent installed. Connect your account next.' }; })
    .catch(error => { integrationJobs[provider] = { state: 'error', message: error instanceof Error ? error.message : 'Agent installation failed' }; });
};

const ensureOllamaRuntime = async update => {
  let executable = await ollamaCommand();
  if (!await commandWorks(executable, ['--version'])) {
    if (process.platform === 'darwin') {
      try {
        await runCommand('brew', ['install', 'ollama'], { timeout: 15 * 60_000, onOutput: update });
      } catch {
        update('Homebrew needs repair or updated package metadata. Updating Homebrew, then retrying Ollama…');
        await runCommand('brew', ['update'], { timeout: 15 * 60_000, onOutput: update });
        await runCommand('brew', ['install', 'ollama'], { timeout: 15 * 60_000, onOutput: update });
      }
    }
    else if (process.platform === 'linux') await downloadAndRunScript('https://ollama.com/install.sh', [], update);
    else if (process.platform === 'win32') await downloadAndRunPowerShell('https://ollama.com/install.ps1', update);
    else throw new Error('Automatic Ollama installation is not supported on this operating system.');
    executable = await ollamaCommand();
    if (!await commandWorks(executable, ['--version'])) throw new Error('Ollama installation finished, but its command could not be found. Restart Quizzer and retry.');
  }
  if (!await commandWorks(executable, ['list'], 5_000)) {
    const server = spawn(executable, ['serve'], { detached: true, stdio: 'ignore', env: process.env });
    server.unref();
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  return executable;
};

const installOllama = () => {
  if (integrationJobs.ollama.state === 'working' || integrationJobs.embeddings.state === 'working') return;
  integrationJobs.ollama = { state: 'working', message: 'Installing the local Ollama runtime…' };
  void (async () => {
    const update = output => { integrationJobs.ollama.message = output || integrationJobs.ollama.message; };
    await ensureOllamaRuntime(update);
    integrationJobs.ollama = { state: 'complete', message: 'Ollama is installed and its local service is ready.' };
  })().catch(error => {
    integrationJobs.ollama = { state: 'error', message: error instanceof Error ? error.message : 'Ollama installation failed' };
  });
};

const pullOllamaModel = model => {
  const modelName = validateOllamaModelName(model);
  if (integrationJobs.ollama.state === 'working' || integrationJobs.embeddings.state === 'working') return false;
  integrationJobs.ollama = { state: 'working', message: `Preparing to download ${modelName}…` };
  void (async () => {
    const update = output => { integrationJobs.ollama.message = output || integrationJobs.ollama.message; };
    const executable = await ensureOllamaRuntime(update);
    integrationJobs.ollama.message = `Downloading ${modelName}. The required disk space depends on the selected model…`;
    await runCommand(executable, ['pull', modelName], { timeout: 60 * 60_000, onOutput: update });
    integrationJobs.ollama = { state: 'complete', message: `${modelName} is installed and ready for local generation.` };
  })().catch(error => {
    integrationJobs.ollama = { state: 'error', message: error instanceof Error ? error.message : 'Ollama model download failed' };
  });
  return true;
};

const installEmbeddings = model => {
  const modelName = validateOllamaModelName(model);
  if (integrationJobs.embeddings.state === 'working' || integrationJobs.ollama.state === 'working') return false;
  integrationJobs.embeddings = { state: 'working', message: `Preparing the local embedding runtime for ${modelName}…` };
  void (async () => {
    const update = output => { integrationJobs.embeddings.message = output || integrationJobs.embeddings.message; };
    const executable = await ensureOllamaRuntime(update);
    integrationJobs.embeddings.message = `Downloading ${modelName}…`;
    await runCommand(executable, ['pull', modelName], { timeout: 60 * 60_000, onOutput: update });
    integrationJobs.embeddings = { state: 'complete', message: `${modelName} is installed and dense retrieval is ready.` };
  })().catch(error => {
    integrationJobs.embeddings = { state: 'error', message: error instanceof Error ? error.message : 'Embedding installation failed' };
  });
  return true;
};

const runCapturedCommand = (command, args, prompt, signal, timeout = 600_000) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(cancellationError());
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stdout = '';
  let stderr = '';
  let failure;
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  };
  const abort = () => {
    failure = cancellationError();
    child.kill('SIGTERM');
  };
  const timer = setTimeout(() => {
    failure = new Error(`${command} timed out after ${Math.round(timeout / 60_000)} minutes`);
    child.kill('SIGTERM');
  }, timeout);
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', error => { cleanup(); reject(error); });
  child.on('close', code => {
    cleanup();
    if (failure) reject(failure);
    else if (code === 0) resolve(stdout.trim());
    else reject(new Error(stripTerminalCodes(stderr || stdout) || `${command} exited with code ${code}`));
  });
  child.stdin.end(prompt);
});

const runCodex = async ({ prompt, schema, model, images = [] }, signal) => {
  if (signal?.aborted) throw cancellationError();
  const work = await mkdtemp(join(tmpdir(), 'quizzer-codex-'));
  const schemaPath = join(work, 'schema.json');
  const outputPath = join(work, 'result.json');
  await writeFile(schemaPath, JSON.stringify(schema));
  const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
    '--output-schema', schemaPath, '--output-last-message', outputPath, '-'];
  if (model) args.splice(1, 0, '--model', model);
  for (const [index, image] of images.slice(0, 30).entries()) {
    const decoded = decodeImage(image, index);
    const imagePath = join(work, decoded.path);
    await writeFile(imagePath, decoded.data);
    args.splice(args.length - 1, 0, '--image', imagePath);
  }

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('codex', args, { stdio: ['pipe', 'ignore', 'pipe'], env: process.env });
      let errors = '';
      let failure;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        failure = cancellationError();
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => {
        failure = new Error('Codex timed out after 10 minutes');
        child.kill('SIGTERM');
      }, 600_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stderr.on('data', chunk => { errors += chunk.toString(); });
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup();
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error(errors.trim() || `Codex exited with code ${code}`));
      });
      child.stdin.end(prompt);
    });
    return await readFile(outputPath, 'utf8');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

const runClaudeAgent = async ({ prompt, schema, model }, signal) => {
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--permission-mode', 'plan', '--max-turns', '1', '--no-session-persistence'];
  if (model) args.push('--model', model);
  const output = await runCapturedCommand('claude', args, prompt, signal);
  const envelope = JSON.parse(output);
  const structured = envelope.structured_output ?? envelope.result;
  if (!structured) throw new Error(envelope.error || 'Claude Agent returned no structured output');
  return typeof structured === 'string' ? structured : JSON.stringify(structured);
};

const runAntigravityAgent = async ({ prompt, schema, model }, signal) => {
  const args = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--sandbox', '--print-timeout', '10m'];
  if (model) args.push('--model', model);
  const output = await runCapturedCommand('agy', args, '', signal);
  const envelope = JSON.parse(output);
  if (envelope.status !== 'SUCCESS') throw new Error(envelope.error || 'Antigravity Agent failed');
  const structured = envelope.structured_output ?? envelope.response;
  if (!structured) throw new Error('Antigravity Agent returned no structured output');
  return typeof structured === 'string' ? structured : JSON.stringify(structured);
};

const providerRunners = {
  plugin: (body, signal) => runGeneratorPlugin(body, signal, { loadManager: getPluginManager }),
  ollama: runOllamaGeneration,
  'llama-cpp': async (body, signal) => runLlamaCppGeneration({
    ...body,
    endpoint: body.endpoint
      || body.resolvedSettings?.['providers.llama-cpp.endpoint']
      || (await loadResolvedSettings(appDataDirectory)).values['providers.llama-cpp.endpoint'],
    model: body.model
      || body.resolvedSettings?.['providers.llama-cpp.model']
      || (await loadResolvedSettings(appDataDirectory)).values['providers.llama-cpp.model'],
  }, signal),
  codex: runCodex,
  'claude-agent': runClaudeAgent,
  'antigravity-agent': runAntigravityAgent,
  gemini: runBuiltinGemini,
  anthropic: runBuiltinAnthropic,
  openai: runBuiltinOpenAI,
  openrouter: (body, signal) => runBuiltinOpenAICompatible(body, signal, {
    label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', defaultModel: 'openai/gpt-4o-mini', jsonSchema: true, supportsImages: true, providerRouting: true,
  }),
  deepseek: (body, signal) => runBuiltinOpenAICompatible(body, signal, {
    label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', defaultModel: 'deepseek-v4-flash', jsonSchema: false, supportsImages: false,
  }),
  'openai-compatible': async (body, signal) => {
    const endpoint = body.endpoint
      || body.resolvedSettings?.['providers.openai-compatible.endpoint']
      || (await loadResolvedSettings(appDataDirectory)).values['providers.openai-compatible.endpoint'];
    return runOpenAICompatibleGeneration({ ...body, endpoint }, signal);
  },
};

const generationWorkerId = `service-${randomUUID()}`;
const generationWorker = process.env.QUIZZER_DISABLE_SERVICE_GENERATION === '1' ? undefined : new GenerationJobWorker({
  claim: async () => {
    const settings = await loadResolvedSettings(appDataDirectory);
    return claimGenerationJob({
      workerId: generationWorkerId,
      leaseMs: 45_000,
      providerConcurrency: providerConcurrencyLimits(settings.values),
    })?.data;
  },
  getConcurrency: async () => (await loadResolvedSettings(appDataDirectory)).values['generation.concurrency'],
  update: (job, patch) => updateGenerationJobWithLease(job.id, {
    workerId: job.workerId, leaseId: job.leaseId, patch,
  }).data,
  renew: job => renewGenerationJobLease(job.id, {
    workerId: job.workerId, leaseId: job.leaseId, leaseMs: 45_000,
  }).data,
  complete: (job, completion) => completeGenerationJob(job.id, {
    workerId: job.workerId, leaseId: job.leaseId, ...completion,
  }).job.data,
  reserveGenerationAttempt: (id, params) => reserveGenerationAttempt(id, params).data,
  finalizeGenerationAttempt: (id, params) => finalizeGenerationAttempt(id, params).data,
  getJob: id => getRecord('generationJobs', id)?.data,
  loadDocuments: ids => ids.map(id => {
    const record = getRecord('documents', id);
    return record ? { id: record.id, ...record.data } : undefined;
  }).filter(Boolean),
  ensureIndexed: documents => {
    for (const document of documents) retrievalIndex.indexSparseDocument({ id: document.id, data: document });
  },
  retrieve: options => retrievalIndex.retrieve(options),
  embed: async (texts, signal) => {
    const settings = await loadResolvedSettings(appDataDirectory);
    const embedding = await resolveEmbeddingProvider(settings, { loadManager: getPluginManager });
    return embedding.embed(texts, { signal });
  },
  loadImage: async image => {
    if (typeof image?.data === 'string' && image.data) return `data:${image.mimeType};base64,${image.data}`;
    if (!image?.object?.sha256) return undefined;
    const data = await objectStore.readBuffer(image.object.sha256);
    return `data:${image.mimeType || image.object.type || 'image/png'};base64,${data.toString('base64')}`;
  },
  requestProvider: async (request, signal) => {
    const runner = providerRunners[request.provider];
    if (!runner) throw new Error('Unsupported provider');
    try {
      return await runner({
        ...request,
        apiKey: PROVIDER_POLICIES[request.provider]?.billing === 'usage-based'
          ? providerCredentials.get(request.provider)
          : undefined,
      }, signal);
    } catch (error) {
      throw normalizeProviderError(error);
    }
  },
  onError: (id, error) => process.stderr.write(
    `Generation worker ${id} failed: ${error instanceof Error ? error.message : String(error)}\n`,
  ),
});

const walkFiles = async directory => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(path));
    else result.push(path);
  }
  return result;
};

const cleanMarkdownContext = value => value
  .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
  .replace(/<img\b[^>]*>/gi, ' ')
  .replace(/[`#>*_|~-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const imageReferences = markdown => {
  const references = [];
  const markdownPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const htmlPattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*?(?:\balt=["']([^"']*)["'])?[^>]*>/gi;
  for (const match of markdown.matchAll(markdownPattern)) {
    references.push({ index: match.index ?? 0, path: match[2], caption: match[1] });
  }
  for (const match of markdown.matchAll(htmlPattern)) {
    references.push({ index: match.index ?? 0, path: match[1], caption: match[2] || '' });
  }
  return references;
};

const pageNear = (markdown, index, filename) => {
  const preceding = markdown.slice(0, index);
  const markers = [...preceding.matchAll(/---\s*Page\s+(\d+)\s*---/gi)];
  const fromMarkdown = Number(markers.at(-1)?.[1]);
  if (fromMarkdown) return fromMarkdown;
  const markerPages = [...preceding.matchAll(/^\{(\d+)\}-{20,}$/gm)];
  if (markerPages.length) return Number(markerPages.at(-1)?.[1]) + 1;
  const fromName = /(?:^|[_-])page[_-]?(\d+)(?:[_-]|\.)/i.exec(filename)
    ?? /(?:^|[_-])p[_-]?(\d+)(?:[_-]|\.)/i.exec(filename);
  return fromName ? Number(fromName[1]) : undefined;
};

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await mapper(items[index], index);
    }
  }));
  return result;
};

const runMarker = async ({ name, data, ocrEnabled = false }, signal, { ocr } = {}) => {
  if (typeof data !== 'string' || !data) throw new Error('PDF data is required');
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : cancellationError();
  const work = await mkdtemp(join(tmpdir(), 'quizzer-marker-'));
  const safeName = String(name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const input = join(work, safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`);
  const output = join(work, 'output');
  await writeFile(input, Buffer.from(data, 'base64'));
  try {
    const executable = await markerCommand();
    await runCommand(executable, [input, '--output_dir', output, '--output_format', 'markdown', '--paginate_output'], {
      timeout: 10 * 60_000, signal,
    }).catch(error => { throw error?.code === 'ENOENT' ? new Error('Marker is not installed') : error; });
    const files = await walkFiles(output);
    const markdownPath = files.find(path => path.endsWith('.md'));
    if (!markdownPath) throw new Error('Marker produced no Markdown output');
    const markdown = await readFile(markdownPath, 'utf8');
    const references = imageReferences(markdown);
    const imagePaths = files.filter(path => /\.(png|jpe?g|webp)$/i.test(path));
    const canOcr = Boolean(ocrEnabled) && typeof ocr === 'function';
    const images = await mapWithConcurrency(imagePaths, 2, async (path, index) => {
      const name = basename(path);
      const reference = references.find(item => {
        try { return basename(decodeURIComponent(item.path.split(/[?#]/)[0])) === name; }
        catch { return basename(item.path.split(/[?#]/)[0]) === name; }
      });
      const sourceStart = reference?.index;
      const context = sourceStart === undefined ? '' : cleanMarkdownContext(markdown.slice(Math.max(0, sourceStart - 500), sourceStart + 700));
      const caption = cleanMarkdownContext(reference?.caption || '');
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : cancellationError();
      const lower = name.toLowerCase();
      const mimeType = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      const ocrText = canOcr ? await ocr(await readFile(path), { name, mimeType, signal }).catch(error => {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        return '';
      }) : '';
      return {
        id: `image-${index}`,
        name,
        mimeType,
        object: await objectStore.putBuffer(await readFile(path), { type: mimeType, name }),
        page: pageNear(markdown, sourceStart ?? 0, name),
        sourceStart,
        caption: caption || undefined,
        context: context || undefined,
        ocrText: cleanMarkdownContext(ocrText) || undefined,
      };
    });
    return { content: markdown, images, parserVersion: 'marker-managed-1' };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

const configuredExtractionRoutes = async ({ ocrRequested = true } = {}) => {
  const settings = await loadResolvedSettings(appDataDirectory);
  const extractorRoute = await resolveDocumentExtractor(settings, { loadManager: getPluginManager });
  const ocrRoute = settings.values['extraction.ocr'] && ocrRequested
    ? await resolveOcrProvider(settings, { loadManager: getPluginManager, builtin: runManagedOcrBuffer })
    : { component: 'disabled', identity: 'disabled', ocr: undefined };
  return { settings, extractorRoute, ocrRoute };
};

const decodeDocumentPayload = data => {
  if (typeof data !== 'string' || !data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('Document data must be valid base64');
  }
  const decoded = Buffer.from(data, 'base64');
  if (!decoded.length) throw new Error('Document data is empty');
  return decoded;
};

const runConfiguredExtraction = async (body, signal) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Extraction request must be an object');
  const name = typeof body.name === 'string' && body.name.length <= 1024 ? body.name : 'document.pdf';
  const data = decodeDocumentPayload(body.data);
  const mimeType = typeof body.mimeType === 'string' && body.mimeType.length <= 255
    ? body.mimeType
    : name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : undefined;
  const routes = await configuredExtractionRoutes({ ocrRequested: body.ocrEnabled === true });

  if (routes.extractorRoute.extract) {
    return extractDocumentBuffer(data, {
      name,
      mimeType,
      extractor: routes.extractorRoute.extract,
      ocr: routes.ocrRoute.ocr,
      signal,
    });
  }
  if ((mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf'))
    && routes.settings.values['extraction.marker']) {
    return runMarker({ name, data: body.data, ocrEnabled: Boolean(routes.ocrRoute.ocr) }, signal, {
      ocr: routes.ocrRoute.ocr,
    });
  }
  return extractDocumentBuffer(data, { name, mimeType, signal });
};

const handleVersionedApi = async (request, response, url) => {
  if (!url.pathname.startsWith('/api/v1/')) return false;
  if (!isAuthorizedRequest(request, serviceToken)) {
    send(response, 401, { error: 'A valid Quizzer service token is required', code: 'unauthorized' });
    return true;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/v1/health') {
      send(response, 200, { ok: true, version: 1, storage: storageInfo() });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/openapi.yaml') {
      response.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(openApiDocument);
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/integrations/llama-cpp/configure') {
      send(response, 200, await configureLlamaCpp(await readJson(request)));
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/integrations/llama-cpp/runtime') {
      send(response, 200, { runtime: await llamaCppRuntime.getStatus() });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/integrations/llama-cpp/runtime/configure') {
      send(response, 200, { runtime: await llamaCppRuntime.configure(await readJson(request)) });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/integrations/llama-cpp/runtime/start') {
      const lifetime = bindRequestCancellation(request, response, 'llama.cpp start request disconnected');
      try { send(response, 200, { runtime: await llamaCppRuntime.start({ ...(await readJson(request)), signal: lifetime.signal }) }); }
      finally { lifetime.dispose(); }
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/integrations/llama-cpp/runtime/stop') {
      send(response, 200, { runtime: await llamaCppRuntime.stop(await readJson(request)) });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/capabilities') {
      const hardware = detectHardwareCapabilities(appDataDirectory);
      const settings = await loadResolvedSettings(appDataDirectory);
      send(response, 200, {
        apiVersion: 1,
        hardware,
        providers: Object.keys(providerRunners),
        providerPolicies: publicProviderPolicies(settings.values),
        operations: ['settings', 'provider-credentials', 'onboarding', 'migrations', 'backups', 'plugins', 'objects', 'documents', 'indexing', 'retrieval', 'jobs', 'events'],
      });
      return true;
    }
    const objectMatch = /^\/api\/v1\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
    if (objectMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      await sendStoredObject(request, response, objectMatch[1]);
      return true;
    }
    if (objectMatch && request.method === 'PUT') {
      const reference = await objectStore.putStream(request, objectMatch[1], {
        type: request.headers['content-type'],
        contentLength: request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']),
      });
      send(response, 201, { object: reference });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/objects/status') {
      send(response, 200, await objectStore.status(referencedObjectIds()));
      return true;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/v1/objects/unreferenced') {
      if (url.searchParams.get('confirm') !== 'true') throw new Error('Object cleanup requires confirm=true');
      const minimumAgeHours = Number(url.searchParams.get('minimumAgeHours') ?? 24);
      if (!Number.isFinite(minimumAgeHours) || minimumAgeHours < 0 || minimumAgeHours > 8_760) {
        throw new Error('minimumAgeHours must be between 0 and 8760');
      }
      send(response, 200, await pruneUnreferencedObjects(minimumAgeHours * 60 * 60 * 1000));
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/settings/schema') {
      send(response, 200, { schema: SETTINGS_SCHEMA, registry: SETTINGS_REGISTRY, profiles: HARDWARE_PROFILE_SETTINGS });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/backups') {
      send(response, 200, { backups: await listBackups(manualBackupRoot) });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/backups') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const id = `backup-${stamp}-${randomUUID().slice(0, 8)}`;
      const manifest = await createBackup({
        destination: join(manualBackupRoot, id),
        database: { backupDatabase },
        objectStore,
        settingsFile: settingsPath(appDataDirectory),
      });
      send(response, 201, { backup: { id, manifest } });
      return true;
    }
    const backupMatch = /^\/api\/v1\/backups\/([A-Za-z0-9._-]{1,160})$/.exec(url.pathname);
    if (backupMatch && request.method === 'GET') {
      const result = await verifyBackup(join(manualBackupRoot, backupMatch[1]));
      send(response, 200, { backup: { id: backupMatch[1], ...result } });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/settings') {
      const profile = url.searchParams.get('profile') || undefined;
      send(response, 200, await loadResolvedSettings(appDataDirectory, { profile }));
      return true;
    }
    if (request.method === 'PATCH' && url.pathname === '/api/v1/settings') {
      await updateUserSettings(await readJson(request));
      send(response, 200, await loadResolvedSettings(appDataDirectory));
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/provider-credentials') {
      send(response, 200, providerCredentials.status());
      return true;
    }
    if (request.method === 'PUT' && url.pathname === '/api/v1/provider-credentials') {
      const body = await readJson(request);
      send(response, 200, providerCredentials.replace(body?.values));
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/plugins/schema') {
      send(response, 200, { schema: pluginManifestSchema });
      return true;
    }
    if (request.method === 'GET' && (url.pathname === '/api/v1/plugins/registry' || (url.pathname === '/api/v1/plugins' && url.searchParams.get('registry') === 'true'))) {
      const manager = await getPluginManager();
      const lifetime = bindRequestCancellation(request, response, 'Plugin registry request disconnected');
      try {
        send(response, 200, { plugins: await manager.listRegistry({ signal: lifetime.signal }) });
      } catch (error) {
        if (!response.destroyed) send(response, 200, { plugins: [], warning: error instanceof Error ? error.message : String(error) });
      } finally {
        lifetime.dispose();
      }
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/plugins') {
      const manager = await getPluginManager();
      send(response, 200, { builtIn: builtInPlugins, plugins: await manager.list() });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/plugins/install') {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Install request body must be an object');
      }
      if (body.path !== undefined && body.id !== undefined) {
        throw new Error('Install request cannot specify both path and id');
      }
      if (body.path === undefined && body.id === undefined) {
        throw new Error('Install request must specify exactly one of path or id');
      }
      const manager = await getPluginManager();
      if (body.id !== undefined) {
        const allowedKeys = new Set(['id', 'confirmed', 'confirmationToken']);
        const unknownKeys = Object.keys(body).filter(key => !allowedKeys.has(key));
        if (unknownKeys.length) throw new Error(`Unknown field(s) in registry install request: ${unknownKeys.join(', ')}`);
        if (typeof body.id !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/.test(body.id)) {
          throw new Error(`Invalid plugin id: ${body.id}`);
        }
        if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') throw new Error('confirmed must be a boolean');
        if (body.confirmed === true && !/^[a-f0-9]{64}$/.test(body.confirmationToken ?? '')) {
          throw new Error('A valid confirmationToken is required when confirmed is true');
        }
        if (body.confirmed !== true && body.confirmationToken !== undefined) {
          throw new Error('confirmationToken requires confirmed to be true');
        }
        const lifetime = bindRequestCancellation(request, response, 'Plugin installation request disconnected');
        try {
          const plugin = await manager.installFromRegistry(body.id, {
            confirmed: body.confirmed === true,
            confirmationToken: body.confirmationToken,
            signal: lifetime.signal,
          });
          send(response, 201, { plugin });
        } finally {
          lifetime.dispose();
        }
        return true;
      }
      const unknownKeys = Object.keys(body).filter(key => key !== 'path');
      if (unknownKeys.length) throw new Error(`Unknown field(s) in local install request: ${unknownKeys.join(', ')}`);
      if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > 4_096 || body.path.includes('\0')) {
        throw new Error('Plugin path must be a non-empty string');
      }
      send(response, 201, { plugin: await manager.install(body.path) });
      return true;
    }
    const pluginActionMatch = /^\/api\/v1\/plugins\/([^/]+)\/(enable|disable|health|rollback|update)$/.exec(url.pathname);
    if (pluginActionMatch && request.method === 'POST') {
      const id = decodeURIComponent(pluginActionMatch[1]);
      const action = pluginActionMatch[2];
      const manager = await getPluginManager();
      let result;
      if (action === 'health') {
        result = { health: await manager.health(id) };
      } else if (action === 'rollback') {
        result = { plugin: await manager.rollback(id) };
      } else if (action === 'update') {
        const hasBody = (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
          || request.headers['transfer-encoding'] !== undefined;
        let body = {};
        if (hasBody) {
          body = await readJson(request);
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('Update request body must be an object');
          }
          const allowedKeys = new Set(['confirmed', 'confirmationToken']);
          const unknownKeys = Object.keys(body).filter(k => !allowedKeys.has(k));
          if (unknownKeys.length > 0) {
            throw new Error(`Unknown field(s) in update request: ${unknownKeys.join(', ')}`);
          }
          if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') {
            throw new Error('confirmed must be a boolean');
          }
          if (body.confirmed === true && !/^[a-f0-9]{64}$/.test(body.confirmationToken ?? '')) {
            throw new Error('A valid confirmationToken is required when confirmed is true');
          }
          if (body.confirmed !== true && body.confirmationToken !== undefined) {
            throw new Error('confirmationToken requires confirmed to be true');
          }
        }
        const lifetime = bindRequestCancellation(request, response, 'Plugin update request disconnected');
        try {
          result = { plugin: await manager.update(id, {
            confirmed: body.confirmed === true,
            confirmationToken: body.confirmationToken,
            signal: lifetime.signal,
          }) };
        } finally {
          lifetime.dispose();
        }
      } else {
        result = { plugin: await manager.setEnabled(id, action === 'enable') };
      }
      send(response, 200, result);
      return true;
    }
    const pluginMatch = /^\/api\/v1\/plugins\/([^/]+)$/.exec(url.pathname);
    if (pluginMatch && request.method === 'DELETE') {
      if (url.searchParams.get('confirm') !== 'true') throw new Error('Plugin removal requires confirm=true');
      const manager = await getPluginManager();
      send(response, 200, await manager.remove(decodeURIComponent(pluginMatch[1])));
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/onboarding') {
      const profile = getRecord('profiles', 'default');
      send(response, profile ? 200 : 404, profile ? { profile: publicRecord(profile) } : { error: 'Profile not found' });
      return true;
    }
    if (request.method === 'PUT' && url.pathname === '/api/v1/onboarding') {
      const body = await readJson(request);
      const onboarding = validateOnboardingState(body?.onboarding);
      const current = getRecord('profiles', 'default')?.data ?? {
        id: 'default', createdAt: Date.now(), interfaceMode: 'simple', hardwareProfile: 'lite', upgradedExistingLibrary: false,
      };
      const profile = { ...current, id: 'default', onboarding, updatedAt: Date.now() };
      send(response, 200, { profile: publicRecord(putRecord('profiles', 'default', profile)) });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/documents') {
      send(response, 200, { documents: listRecords('documents').map(documentSummary) });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/index/status') {
      send(response, 200, await retrievalIndex.status());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/index') {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Index request must be an object');
      if (body.force !== undefined && typeof body.force !== 'boolean') throw new Error('force must be a boolean');
      if (body.wait !== undefined && typeof body.wait !== 'boolean') throw new Error('wait must be a boolean');
      const selected = selectIndexDocuments(body.documentIds);
      let jobRecord = prepareIndexJob({
        records: selected,
        force: body.force ?? false,
        idempotencyKey: body.idempotencyKey,
      });
      if (jobRecord.data.status !== 'completed') {
        const execution = executeIndexJob(jobRecord.id);
        if (body.wait !== false) await execution;
        else void execution.catch(error => reportIndexFailure(jobRecord.id, error));
        jobRecord = getRecord('indexJobs', jobRecord.id);
      }
      send(response, body.wait === false ? 202 : 200, {
        job: publicRecord(jobRecord),
        indexed: jobRecord.data.results,
        status: await retrievalIndex.status(),
      });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/index/jobs') {
      send(response, 200, { jobs: listRecords('indexJobs').map(publicRecord) });
      return true;
    }
    const indexJobActionMatch = /^\/api\/v1\/index\/jobs\/([^/]+)\/(resume|cancel)$/.exec(url.pathname);
    if (indexJobActionMatch && request.method === 'POST') {
      const id = decodeURIComponent(indexJobActionMatch[1]);
      let existing = getRecord('indexJobs', id);
      if (!existing) {
        send(response, 404, { error: 'Index job not found' });
        return true;
      }
      if (indexJobActionMatch[2] === 'cancel') {
        existing = putRecord('indexJobs', id, cancelIndexJob(existing.data));
        send(response, 200, { job: publicRecord(existing) });
        return true;
      }
      const active = activeIndexExecutions.get(id);
      if (active) await active.catch(() => {});
      existing = getRecord('indexJobs', id);
      const resumed = putRecord('indexJobs', id, resumeIndexJob(existing.data));
      const execution = executeIndexJob(id);
      void execution.catch(error => reportIndexFailure(id, error));
      send(response, 202, { job: publicRecord(resumed) });
      return true;
    }
    const indexJobMatch = /^\/api\/v1\/index\/jobs\/([^/]+)$/.exec(url.pathname);
    if (indexJobMatch && request.method === 'GET') {
      const record = getRecord('indexJobs', decodeURIComponent(indexJobMatch[1]));
      send(response, record ? 200 : 404, record ? { job: publicRecord(record) } : { error: 'Index job not found' });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/retrieval/preview') {
      const lifetime = bindRequestCancellation(request, response, 'Retrieval request disconnected');
      try {
        const body = await readJson(request);
        if (typeof body?.query !== 'string' || !body.query.trim()) throw new Error('A retrieval query is required');
        const selected = selectIndexDocuments(body.documentIds);
        const configuration = await retrievalIndex.configuration();
        const settings = configuration.settings;
        const indexConfiguration = JSON.stringify({
          embeddings: configuration.embeddings,
          embeddingModel: configuration.embeddingModel,
        });
        const retrievalIndexKey = `retrieval.${createHash('sha256').update(`${selected.map(retrievalDocumentFingerprint).join('|')}|${indexConfiguration}`).digest('hex')}`;
        const indexJob = prepareIndexJob({ records: selected, idempotencyKey: retrievalIndexKey });
        let indexingError;
        if (indexJob.data.status !== 'completed') {
          try { await executeIndexJob(indexJob.id); }
          catch (error) { indexingError = error instanceof Error ? error.message : String(error); }
        }
        if (lifetime.signal.aborted) throw lifetime.signal.reason;
        if (indexingError) for (const record of selected) retrievalIndex.indexSparseDocument(record);
        const retrievalOptions = {
          query: body.query,
          documentIds: body.documentIds ?? [],
          tags: body.tags ?? [],
          limit: body.limit,
          contextBudget: body.contextBudget ?? settings.values['retrieval.contextBudget'],
          includeNeighbors: body.includeNeighbors !== false,
          signal: lifetime.signal,
        };
        const result = await retrievalIndex.retrieve(retrievalOptions);
        if (!response.destroyed) send(response, 200, indexingError ? { ...result, indexingError } : result);
        return true;
      } finally {
        lifetime.dispose();
      }
    }
    const reextractDocumentMatch = /^\/api\/v1\/documents\/([^/]+)\/reextract$/.exec(url.pathname);
    if (reextractDocumentMatch && request.method === 'POST') {
      const id = decodeURIComponent(reextractDocumentMatch[1]);
      const existing = getRecord('documents', id);
      if (!existing) {
        send(response, 404, { error: 'Document not found' });
        return true;
      }
      const routes = await configuredExtractionRoutes();
      const extracted = await reextractDocument(existing.data, {
        objectStore,
        extractor: routes.extractorRoute.extract,
        ocr: routes.ocrRoute.ocr,
      });
      const saved = putRecord('documents', id, extracted);
      await retrievalIndex.removeDocument(id);
      const indexJob = prepareIndexJob({ records: [saved], force: true });
      await executeIndexJob(indexJob.id);
      send(response, 200, {
        document: publicRecord(getRecord('documents', id)),
        job: publicRecord(getRecord('indexJobs', indexJob.id)),
      });
      return true;
    }
    const documentMatch = /^\/api\/v1\/documents\/([^/]+)$/.exec(url.pathname);
    if (documentMatch && request.method === 'GET') {
      const record = getRecord('documents', decodeURIComponent(documentMatch[1]));
      send(response, record ? 200 : 404, record ? { document: publicRecord(record) } : { error: 'Document not found' });
      return true;
    }
    if (documentMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(documentMatch[1]);
      if (!getRecord('documents', id)) {
        send(response, 404, { error: 'Document not found' });
        return true;
      }
      deleteRecord('documents', id);
      await retrievalIndex.removeDocument(id);
      send(response, 200, { ok: true });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/jobs') {
      send(response, 200, { jobs: listRecords('generationJobs').map(publicRecord) });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/jobs') {
      const body = await readJson(request);
      const jobs = createGenerationJobs(body?.jobs).map(publicRecord);
      generationWorker?.poke();
      send(response, 201, { jobs });
      return true;
    }
    const accountingMatch = /^\/api\/v1\/jobs\/([^/]+)\/accounting$/.exec(url.pathname);
    if (accountingMatch && request.method === 'GET') {
      const id = decodeURIComponent(accountingMatch[1]);
      const job = getRecord('generationJobs', id);
      if (!job) { send(response, 404, { error: 'Job not found' }); return true; }
      send(response, 200, { job: publicRecord(job), accounting: getGenerationAccounting(id) });
      return true;
    }
    const ceilingMatch = /^\/api\/v1\/jobs\/([^/]+)\/accounting\/ceiling$/.exec(url.pathname);
    if (ceilingMatch && request.method === 'POST') {
      const body = await readJson(request);
      const job = raiseGenerationCostCeiling(decodeURIComponent(ceilingMatch[1]), {
        newCeilingMicroUsd: body?.newCeilingMicroUsd,
        reason: body?.reason,
        confirmed: body?.confirmed,
      });
      send(response, 200, { job: publicRecord(job), accounting: getGenerationAccounting(job.id) });
      return true;
    }
    const recoveryMatch = /^\/api\/v1\/jobs\/([^/]+)\/accounting\/recovery$/.exec(url.pathname);
    if (recoveryMatch && request.method === 'POST') {
      const body = await readJson(request);
      const job = approveGenerationCostRecovery(decodeURIComponent(recoveryMatch[1]), {
        reason: body?.reason, confirmed: body?.confirmed,
      });
      send(response, 200, { job: publicRecord(job), accounting: getGenerationAccounting(job.id) });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/jobs/claim') {
      const body = await readJson(request);
      const settings = await loadResolvedSettings(appDataDirectory);
      const job = claimGenerationJob({
        workerId: body?.workerId,
        leaseMs: body?.leaseMs,
        providerConcurrency: providerConcurrencyLimits(settings.values),
      });
      send(response, 200, { job: job ? publicRecord(job) : undefined });
      return true;
    }
    const jobLeaseMatch = /^\/api\/v1\/jobs\/([^/]+)\/lease$/.exec(url.pathname);
    if (jobLeaseMatch && request.method === 'POST') {
      const body = await readJson(request);
      const job = renewGenerationJobLease(decodeURIComponent(jobLeaseMatch[1]), body);
      send(response, 200, { job: publicRecord(job) });
      return true;
    }
    const jobCompleteMatch = /^\/api\/v1\/jobs\/([^/]+)\/complete$/.exec(url.pathname);
    if (jobCompleteMatch && request.method === 'POST') {
      const body = await readJson(request);
      const result = completeGenerationJob(decodeURIComponent(jobCompleteMatch[1]), body);
      send(response, 200, { job: publicRecord(result.job), test: publicRecord(result.test) });
      return true;
    }
    const jobMatch = /^\/api\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
    if (jobMatch && request.method === 'PATCH') {
      const body = await readJson(request);
      const job = updateGenerationJobWithLease(decodeURIComponent(jobMatch[1]), body);
      send(response, 200, { job: publicRecord(job) });
      return true;
    }
    const jobActionMatch = /^\/api\/v1\/jobs\/([^/]+)\/(resume|cancel)$/.exec(url.pathname);
    if (jobActionMatch && request.method === 'POST') {
      const id = decodeURIComponent(jobActionMatch[1]);
      if (!getRecord('generationJobs', id)) {
        send(response, 404, { error: 'Job not found' });
        return true;
      }
      const body = request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'
        ? await readJson(request)
        : {};
      const job = controlGenerationJob(id, jobActionMatch[2], body);
      if (jobActionMatch[2] === 'cancel') generationWorker?.cancel(id);
      else generationWorker?.poke();
      send(response, 200, { job: publicRecord(job) });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/events') {
      sendStorageEvents(request, response);
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/migrations') {
      send(response, 200, { migrations: listLegacyMigrations() });
      return true;
    }
  } catch (error) {
    if (!response.destroyed) {
      const payload = { error: error instanceof Error ? error.message : 'Invalid API request' };
      if (error?.confirmationRequired) {
        payload.code = 'plugin_confirmation_required';
        payload.confirmationRequired = true;
        payload.reasons = error.reasons;
        payload.details = error.details;
      }
      send(response, 400, payload);
    }
    return true;
  }
  send(response, 404, { error: 'Not found' });
  return true;
};

const serviceServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': 'http://localhost:5173', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return response.end();
  }
  if (await handleVersionedApi(request, response, url)) return;
  if (request.method === 'GET' && request.url === '/api/health') {
    return send(response, 200, { ok: true, storage: storageInfo(), providers: Object.fromEntries(Object.keys(providerRunners).map(provider => [provider, true])) });
  }
  if (url.pathname.startsWith('/api/') && !isAuthorizedRequest(request, serviceToken)) {
    return send(response, 401, { error: 'A valid Quizzer service token is required', code: 'unauthorized' });
  }
  if (request.method === 'GET' && request.url === '/api/system/capabilities') {
    return send(response, 200, detectHardwareCapabilities(appDataDirectory));
  }
  if (request.method === 'POST' && request.url === '/api/storage/sync') {
    try {
      const body = await readJson(request, maxStorageBodyBytes);
      if (body?.bootstrap) {
        if (!body.migration) throw new Error('A verified legacy migration session is required for initial browser import');
        await beginLegacyMigration(body.migration);
      }
      const migrationPayloadHashes = body?.bootstrap ? new Map((body.changes ?? []).map(change => [
        `${change.collection}:${change.id}`,
        createHash('sha256').update(JSON.stringify(change)).digest('hex'),
      ])) : undefined;
      const changes = await Promise.all((body?.changes ?? []).map(async change => {
        if (change.data === undefined) return { ...change };
        const binaryMaterialized = await materializeSerializedObjects(change.data, objectStore);
        const data = change.collection === 'documents'
          ? (await materializeDocumentImages(binaryMaterialized, objectStore)).document
          : binaryMaterialized;
        return { ...change, data };
      }));
      const result = syncStorage({ ...body, changes }, { migrationPayloadHashes });
      if (body?.bootstrap && body.migration?.complete === true) {
        result.migration = finalizeLegacyMigration(body.migration.id);
      }
      for (const change of body?.changes ?? []) {
        if (change.collection === 'documents' && change.deleted === true && typeof change.id === 'string') await retrievalIndex.removeDocument(change.id);
      }
      return send(response, 200, result);
    }
    catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : 'Storage sync failed' }); }
  }
  if (request.method === 'GET' && request.url === '/api/integrations') {
    return send(response, 200, await integrationStatus());
  }
  if (request.method === 'POST' && ['/api/integrations/llama-cpp/configure', '/api/v1/integrations/llama-cpp/configure'].includes(request.url)) {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    try {
      return send(response, 200, await configureLlamaCpp(await readJson(request)));
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : 'Invalid llama.cpp configuration' });
    }
  }
  if (request.method === 'POST' && request.url === '/api/integrations/marker/install') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    installMarker();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/ocr/install') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    installOcr();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/codex/connect') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    connectCodex();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/claude-agent/connect') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    connectClaude();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/antigravity-agent/connect') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    connectAntigravity();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/claude-agent/install') {
    installAgent('claude-agent', 'https://claude.ai/install.sh');
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/antigravity-agent/install') {
    installAgent('antigravity-agent', 'https://antigravity.google/cli/install.sh');
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/ollama/install') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    try {
      const body = await readJson(request);
      if (body?.confirmed !== true) throw new Error('Explicit confirmation is required before installing Ollama');
      installOllama();
      return send(response, 202, { ok: true });
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : 'Invalid Ollama installation request' });
    }
  }
  if (request.method === 'POST' && request.url === '/api/integrations/ollama/pull') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    try {
      const body = await readJson(request);
      if (body?.confirmed !== true) throw new Error('Explicit confirmation is required before downloading an Ollama model');
      const started = pullOllamaModel(body?.model);
      return send(response, started ? 202 : 409, started
        ? { ok: true }
        : { error: 'Another Ollama installation or model download is already running' });
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : 'Invalid Ollama model' });
    }
  }
  if (request.method === 'POST' && request.url === '/api/integrations/embeddings/install') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    try {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['confirmed', 'model'].includes(key))) {
        throw new Error('Embedding installation request is invalid');
      }
      if (body.confirmed !== true) throw new Error('Explicit confirmation is required before downloading an embedding model');
      const settings = await loadResolvedSettings(appDataDirectory);
      const configuredModel = validateOllamaModelName(settings.values['embeddings.model']);
      if (body.model !== configuredModel) throw new Error('Embedding model changed; review the current profile and confirm again');
      const started = installEmbeddings(configuredModel);
      return send(response, started ? 202 : 409, started
        ? { ok: true, model: configuredModel }
        : { error: 'Another Ollama installation or model download is already running' });
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : 'Invalid embedding installation request' });
    }
  }
  if (request.method === 'POST' && request.url === '/api/extract') {
    const lifetime = bindRequestCancellation(request, response, 'Extraction request disconnected');
    try {
      const result = await runConfiguredExtraction(await readJson(request), lifetime.signal);
      if (!response.destroyed) return send(response, 200, result);
    } catch (error) {
      if (!response.destroyed) return send(response, error?.name === 'AbortError' ? 499 : 503, { error: error instanceof Error ? error.message : 'Extraction failed' });
    } finally {
      lifetime.dispose();
    }
    return undefined;
  }
  if (request.method === 'POST' && request.url === '/api/embed') {
    const lifetime = bindRequestCancellation(request, response, 'Embedding request disconnected');
    try {
      const { texts } = await readJson(request);
      const settings = await loadResolvedSettings(appDataDirectory);
      const embedding = await resolveEmbeddingProvider(settings, { loadManager: getPluginManager });
      const embeddings = await embedding.embed(texts, { signal: lifetime.signal });
      if (!response.destroyed) return send(response, 200, { embeddings });
    } catch (error) {
      if (!response.destroyed) return send(response, error?.name === 'AbortError' ? 499 : 503, { error: error instanceof Error ? error.message : 'Embedding failed' });
    } finally {
      lifetime.dispose();
    }
    return undefined;
  }
  if (request.method !== 'POST' || request.url !== '/api/generate') return send(response, 404, { error: 'Not found' });

  const lifetime = bindRequestCancellation(request, response, 'Generation request disconnected');
  try {
    const body = await readJson(request);
    if (!body || typeof body.prompt !== 'string' || !body.schema) throw new Error('prompt and schema are required');
    const runner = providerRunners[body.provider];
    if (!runner) throw new Error('Unsupported provider');
    const output = await runner({
      ...body,
      apiKey: body.apiKey || (PROVIDER_POLICIES[body.provider]?.billing === 'usage-based'
        ? providerCredentials.get(body.provider)
        : undefined),
    }, lifetime.signal);
    if (!response.destroyed) send(response, 200, { output });
  } catch (error) {
    const normalized = normalizeProviderError(error);
    if (!response.destroyed) send(response, normalized?.name === 'AbortError' ? 499 : normalized?.status || 500, {
      error: normalized instanceof Error ? normalized.message : 'Generation failed',
      code: normalized?.code,
    });
  } finally {
    lifetime.dispose();
  }
});

serviceServer.once('error', error => {
  process.parentPort?.postMessage?.({ type: 'quizzer-service-error', message: error instanceof Error ? error.message : String(error) });
  throw error;
});
let serviceClosing = false;
const closeService = async () => {
  if (serviceClosing) return;
  serviceClosing = true;
  await llamaCppRuntime.stop().catch(error => {
    process.stderr.write(`Could not stop managed llama.cpp during service shutdown: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  await new Promise(resolve => {
    try { serviceServer.close(() => resolve()); }
    catch { resolve(); }
  });
};
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  void closeService().finally(() => process.exit(0));
});
serviceServer.listen(configuredPort, '127.0.0.1', () => {
  const address = serviceServer.address();
  const port = typeof address === 'object' && address ? address.port : configuredPort;
  process.parentPort?.postMessage?.({ type: 'quizzer-service-ready', port });
  process.stdout.write(`Quizzer service listening on http://127.0.0.1:${port}\n`);
  generationWorker?.start();
});
