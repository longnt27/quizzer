import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertPluginTrust, isPluginCompatible, loadPluginManifest, validatePluginManifest, validatePluginPath, verifyPluginFiles, verifyPluginSignature,
} from './manifest.mjs';
import { invokePluginProcess } from './runtime.mjs';
import {
  DEFAULT_PLUGIN_REGISTRY_URL, MAX_CATALOG_SIZE, MAX_INDIVIDUAL_FILE_SIZE, MAX_MANIFEST_SIZE,
  MAX_TOTAL_PLUGIN_SIZE, checkPluginSecurityConfirmations, compareSemver, fetchBoundedBuffer,
  fetchBoundedText, validateRegistryCatalog, verifyRegistryCatalogSignature,
} from './registry.mjs';

const stateVersion = 1;
const catalogManifestFields = ['name', 'description', 'version', 'capabilities', 'platforms', 'resources', 'permissions'];

const assertCatalogMatchesManifest = (entry, manifest) => {
  for (const field of catalogManifestFields) {
    if (!isDeepStrictEqual(entry[field], manifest[field])) {
      throw new Error(`Catalog ${field} does not match the signed plugin manifest for ${entry.id}`);
    }
  }
  if (entry.files.length !== manifest.files.length) {
    throw new Error(`Catalog file list does not match the signed plugin manifest for ${entry.id}`);
  }
  const manifestFiles = new Map(manifest.files.map(file => [file.path, file]));
  for (const file of entry.files) {
    const manifestFile = manifestFiles.get(file.path);
    if (!manifestFile || manifestFile.sha256 !== file.sha256) {
      throw new Error(`Catalog file ${file.path} does not match the signed plugin manifest for ${entry.id}`);
    }
  }
};

const confirmationTokenFor = ({ catalog, entry, manifest, previousManifest, confirmation }) => createHash('sha256')
  .update(catalog.signature)
  .update('\0')
  .update(manifest.signature.value)
  .update('\0')
  .update(previousManifest?.signature?.value ?? previousManifest?.version ?? 'not-installed')
  .update('\0')
  .update(JSON.stringify(confirmation.details))
  .digest('hex');

const rollbackTimestamp = (id, name) => {
  if (!name.startsWith(`${id}--`)) return undefined;
  const separator = name.lastIndexOf('--');
  if (separator < id.length + 2) return undefined;
  const timestamp = Number(name.slice(separator + 2));
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
};

const parseTrustedKeys = environment => {
  if (!environment.QUIZZER_PLUGIN_TRUSTED_KEYS) return {};
  let keys;
  try { keys = JSON.parse(environment.QUIZZER_PLUGIN_TRUSTED_KEYS); }
  catch { throw new Error('QUIZZER_PLUGIN_TRUSTED_KEYS must be a JSON object'); }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)
    || Object.values(keys).some(value => typeof value !== 'string')) throw new Error('QUIZZER_PLUGIN_TRUSTED_KEYS must map key ids to public keys');
  return keys;
};

const parseTrustedRegistryKeys = environment => {
  const raw = environment.QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS !== undefined
    ? environment.QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS
    : environment.QUIZZER_PLUGIN_TRUSTED_KEYS;
  if (!raw) return {};
  let keys;
  try { keys = JSON.parse(raw); }
  catch { throw new Error('QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS must be a JSON object'); }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)
    || Object.values(keys).some(value => typeof value !== 'string')) throw new Error('QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS must map key ids to public keys');
  return keys;
};

export class PluginManager {
  constructor({
    appDataDirectory,
    developerMode = false,
    trustedKeys = parseTrustedKeys(process.env),
    trustedRegistryKeys = parseTrustedRegistryKeys(process.env),
    registryUrl = process.env.QUIZZER_PLUGIN_REGISTRY_URL || DEFAULT_PLUGIN_REGISTRY_URL,
    platform = process.platform,
    architecture = process.arch,
    fetch = globalThis.fetch,
  } = {}) {
    if (typeof appDataDirectory !== 'string' || !appDataDirectory) throw new Error('Plugin app-data directory is required');
    this.appDataDirectory = appDataDirectory;
    this.developerMode = developerMode;
    this.trustedKeys = trustedKeys;
    this.trustedRegistryKeys = trustedRegistryKeys;
    this.registryUrl = registryUrl;
    this.platform = platform;
    this.architecture = architecture;
    this.fetch = fetch;
    this.root = join(appDataDirectory, 'plugins');
    this.installedRoot = join(this.root, 'installed');
    this.rollbackRoot = join(this.root, 'rollback');
    this.removedRoot = join(this.root, 'removed');
    this.stagingRoot = join(this.root, 'staging');
    this.statePath = join(this.root, 'state.json');
  }

  async prepare() {
    await Promise.all([this.installedRoot, this.rollbackRoot, this.removedRoot, this.stagingRoot]
      .map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (state.version !== stateVersion || !state.plugins || typeof state.plugins !== 'object') throw new Error('Plugin state is invalid');
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: stateVersion, plugins: {} };
      throw error;
    }
  }

  async writeState(state) {
    await this.prepare();
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  directoryFor(id) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) throw new Error('Plugin id is invalid');
    return join(this.installedRoot, id);
  }

  async installedPlugin(id) {
    const directory = this.directoryFor(id);
    const manifest = await loadPluginManifest(directory);
    return { directory, manifest };
  }

  async list() {
    await this.prepare();
    const state = await this.readState();
    const [entries, rollbackEntries] = await Promise.all([
      readdir(this.installedRoot, { withFileTypes: true }),
      readdir(this.rollbackRoot, { withFileTypes: true }),
    ]);
    return Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      try {
        const { manifest } = await this.installedPlugin(entry.name);
        const saved = state.plugins[manifest.id] ?? {};
        let blocked;
        try { assertPluginTrust(manifest, { developerMode: this.developerMode, trustedKeys: this.trustedKeys }); }
        catch (error) { blocked = error instanceof Error ? error.message : String(error); }
        const availableVersion = saved.availableVersion ?? manifest.version;
        const updateAvailable = Boolean(availableVersion && compareSemver(availableVersion, manifest.version) > 0);
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          capabilities: manifest.capabilities,
          resources: manifest.resources,
          permissions: manifest.permissions,
          enabled: saved.enabled !== false && !blocked,
          trust: saved.trust ?? (manifest.signature ? 'signed' : 'unsigned-local'),
          source: saved.source ?? (saved.trust === 'signed' ? 'registry' : 'local'),
          registryId: saved.registryId,
          availableVersion,
          updateAvailable,
          compatible: isPluginCompatible(manifest, { platform: this.platform, architecture: this.architecture }),
          warning: blocked ?? saved.warning,
          installedAt: saved.installedAt,
          status: blocked ? 'blocked' : 'installed',
          rollbackAvailable: rollbackEntries.some(rollback => rollback.isDirectory()
            && rollbackTimestamp(manifest.id, rollback.name) !== undefined),
        };
      } catch (error) {
        return { id: entry.name, enabled: false, compatible: false, status: 'broken', error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  async listRegistry(options = {}) {
    if (!this.trustedRegistryKeys || Object.keys(this.trustedRegistryKeys).length === 0) {
      return [];
    }
    const registryUrl = options.registryUrl || this.registryUrl;
    const fetchFn = options.fetch || this.fetch;
    const fetchOpts = { signal: options.signal, timeoutMs: options.timeoutMs };
    const rawCatalog = options.catalog || JSON.parse(await fetchBoundedText(fetchFn, registryUrl, fetchOpts, MAX_CATALOG_SIZE));
    verifyRegistryCatalogSignature(rawCatalog, this.trustedRegistryKeys);
    const catalog = validateRegistryCatalog(rawCatalog);

    const installedList = await this.list();
    const installedMap = new Map(installedList.map(p => [p.id, p]));
    const state = await this.readState();
    let stateModified = false;

    const result = catalog.plugins.map(entry => {
      const installed = installedMap.get(entry.id);
      const isInstalled = Boolean(installed && installed.status !== 'broken');
      const installedVersion = isInstalled ? installed.version : null;
      const updateAvailable = Boolean(isInstalled && compareSemver(entry.version, installedVersion) > 0);
      const compatible = isPluginCompatible(entry, { platform: this.platform, architecture: this.architecture });

      if (isInstalled && state.plugins[entry.id]) {
        if (state.plugins[entry.id].availableVersion !== entry.version) {
          state.plugins[entry.id].availableVersion = entry.version;
          stateModified = true;
        }
      }

      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        version: entry.version,
        capabilities: entry.capabilities,
        platforms: entry.platforms,
        resources: entry.resources,
        permissions: entry.permissions,
        manifestUrl: entry.manifestUrl,
        downloadBaseUrl: entry.downloadBaseUrl,
        downloadSize: entry.downloadSize,
        installed: isInstalled,
        installedVersion,
        updateAvailable,
        compatible,
      };
    });

    if (stateModified) {
      await this.writeState(state);
    }
    return result;
  }

  async copyVerifiedPlugin(sourceDirectory, destination, manifest) {
    await mkdir(destination, { recursive: false, mode: 0o700 });
    await copyFile(join(sourceDirectory, 'quizzer.plugin.json'), join(destination, 'quizzer.plugin.json'));
    for (const file of manifest.files) {
      const relative = validatePluginPath(file.path);
      const target = join(destination, relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(sourceDirectory, relative), target);
    }
  }

  async install(source, options = {}) {
    if (options?.registry) {
      return this.installFromRegistry(source, options);
    }
    let isLocalDir = false;
    try {
      const details = await lstat(resolve(source));
      isLocalDir = details.isDirectory();
    } catch {
      isLocalDir = false;
    }
    if (!isLocalDir && /^[a-z0-9][a-z0-9.-]*$/.test(source)) {
      return this.installFromRegistry(source, options);
    }

    await this.prepare();
    const sourceDirectory = resolve(source);
    const manifest = await loadPluginManifest(sourceDirectory);
    if (!isPluginCompatible(manifest, { platform: this.platform, architecture: this.architecture })) throw new Error(`Plugin ${manifest.id} does not support ${this.platform}/${this.architecture}`);
    const trust = assertPluginTrust(manifest, { developerMode: this.developerMode, trustedKeys: this.trustedKeys });
    const destination = this.directoryFor(manifest.id);
    const staging = join(this.stagingRoot, `${manifest.id}-${randomUUID()}`);
    try {
      await this.copyVerifiedPlugin(sourceDirectory, staging, manifest);
      const stagedManifest = await loadPluginManifest(staging);
      assertPluginTrust(stagedManifest, { developerMode: this.developerMode, trustedKeys: this.trustedKeys });
      let previous;
      try {
        const details = await lstat(destination);
        if (!details.isDirectory()) throw new Error(`Plugin destination is not a directory: ${manifest.id}`);
        let version = 'unknown';
        try { version = (await this.installedPlugin(manifest.id)).manifest.version; }
        catch { /* Preserve a broken install so the verified replacement can repair it. */ }
        previous = join(this.rollbackRoot, `${manifest.id}--${version}--${Date.now()}`);
        await rename(destination, previous);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try { await rename(staging, destination); }
      catch (error) {
        if (previous) await rename(previous, destination).catch(() => {});
        throw error;
      }
      const state = await this.readState();
      state.plugins[manifest.id] = {
        enabled: true,
        trust,
        installedAt: Date.now(),
        source: 'local',
        ...(trust === 'unsigned-local' ? { warning: 'Unsigned local plugin enabled through Advanced Developer Mode.' } : {}),
      };
      await this.writeState(state);
      return (await this.list()).find(plugin => plugin.id === manifest.id);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async installFromRegistry(id, options = {}) {
    await this.prepare();
    const registryUrl = options.registryUrl || this.registryUrl;
    const fetchFn = options.fetch || this.fetch;
    const fetchOpts = { signal: options.signal, timeoutMs: options.timeoutMs };
    const rawCatalog = options.catalog || JSON.parse(await fetchBoundedText(fetchFn, registryUrl, fetchOpts, MAX_CATALOG_SIZE));
    verifyRegistryCatalogSignature(rawCatalog, this.trustedRegistryKeys);
    const catalog = validateRegistryCatalog(rawCatalog);

    const entry = catalog.plugins.find(item => item.id === id);
    if (!entry) throw new Error(`Plugin ${id} not found in registry catalog`);

    if (!isPluginCompatible(entry, { platform: this.platform, architecture: this.architecture })) {
      throw new Error(`Plugin ${entry.id} does not support ${this.platform}/${this.architecture}`);
    }

    let previousManifest = null;
    try {
      previousManifest = (await this.installedPlugin(id)).manifest;
    } catch {
      // Not installed or broken
    }

    const manifestText = await fetchBoundedText(fetchFn, entry.manifestUrl, fetchOpts, MAX_MANIFEST_SIZE);
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      throw new Error(`Invalid quizzer.plugin.json in remote release: ${err.message}`);
    }
    validatePluginManifest(manifest);
    if (manifest.id !== id) throw new Error(`Remote manifest id "${manifest.id}" does not match registry id "${id}"`);
    if (manifest.version !== entry.version) throw new Error(`Remote manifest version "${manifest.version}" does not match registry version "${entry.version}"`);

    // A registry install must never enable unsigned plugins or depend on Developer Mode.
    if (!manifest.signature) {
      throw new Error(`Registry plugin ${id} must be signed with a trusted key; unsigned registry plugins are prohibited`);
    }
    verifyPluginSignature(manifest, this.trustedKeys);

    if (!isPluginCompatible(manifest, { platform: this.platform, architecture: this.architecture })) {
      throw new Error(`Plugin ${manifest.id} does not support ${this.platform}/${this.architecture}`);
    }

    assertCatalogMatchesManifest(entry, manifest);
    const catalogFiles = new Map(entry.files.map(file => [file.path, file]));

    const confirmation = checkPluginSecurityConfirmations(manifest, previousManifest, entry.downloadSize);
    const confirmationToken = confirmationTokenFor({ catalog, entry, manifest, previousManifest, confirmation });
    if (options.confirmationToken !== undefined
      && (typeof options.confirmationToken !== 'string' || options.confirmationToken !== confirmationToken)) {
      throw new Error(`Plugin security confirmation expired for ${id}; review the current permissions and download size again`);
    }
    if (confirmation.requiresConfirmation && options.confirmed !== true) {
      const err = new Error(`Explicit confirmation required for ${id}: ${confirmation.reasons.join('; ')}`);
      err.confirmationRequired = true;
      err.reasons = confirmation.reasons;
      err.details = {
        ...confirmation.details,
        confirmationToken,
        pluginId: id,
        version: manifest.version,
      };
      throw err;
    }

    const staging = join(this.stagingRoot, `${manifest.id}-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });

    try {
      await writeFile(join(staging, 'quizzer.plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      let totalBytesReceived = 0;
      for (const file of manifest.files) {
        const relative = validatePluginPath(file.path);
        const catFile = catalogFiles.get(file.path);
        const fileUrl = catFile.url;

        const target = join(staging, relative);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });

        const fileBuffer = await fetchBoundedBuffer(fetchFn, fileUrl, fetchOpts, MAX_INDIVIDUAL_FILE_SIZE);
        totalBytesReceived += fileBuffer.length;
        if (totalBytesReceived > MAX_TOTAL_PLUGIN_SIZE) {
          throw new Error(`Total plugin size exceeded limit of ${MAX_TOTAL_PLUGIN_SIZE} bytes`);
        }

        if (fileBuffer.length !== catFile.size) {
          throw new Error(`Downloaded file size mismatch for ${file.path}: expected ${catFile.size}, got ${fileBuffer.length}`);
        }

        const fileHash = createHash('sha256').update(fileBuffer).digest('hex');
        if (fileHash !== file.sha256) {
          throw new Error(`Plugin file hash mismatch for ${file.path}: expected ${file.sha256}, got ${fileHash}`);
        }

        await writeFile(target, fileBuffer, { mode: 0o700 });
      }

      if (totalBytesReceived !== entry.downloadSize) {
        throw new Error(`Downloaded payload size mismatch for ${id}: expected ${entry.downloadSize} bytes, received ${totalBytesReceived} bytes`);
      }
      if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('Plugin installation cancelled'), { name: 'AbortError' });

      const stagedManifest = await loadPluginManifest(staging, { verifyFiles: true });
      assertPluginTrust(stagedManifest, { developerMode: false, trustedKeys: this.trustedKeys });

      const destination = this.directoryFor(manifest.id);
      let previousBackup;
      try {
        const details = await lstat(destination);
        if (!details.isDirectory()) throw new Error(`Plugin destination is not a directory: ${manifest.id}`);
        let oldVersion = 'unknown';
        try { oldVersion = (await this.installedPlugin(manifest.id)).manifest.version; } catch {}
        previousBackup = join(this.rollbackRoot, `${manifest.id}--${oldVersion}--${Date.now()}`);
        await rename(destination, previousBackup);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      try {
        await rename(staging, destination);
      } catch (error) {
        if (previousBackup) await rename(previousBackup, destination).catch(() => {});
        throw error;
      }

      const state = await this.readState();
      state.plugins[manifest.id] = {
        enabled: true,
        trust: 'signed',
        installedAt: Date.now(),
        source: 'registry',
        registryId: id,
        version: manifest.version,
        availableVersion: manifest.version,
      };
      await this.writeState(state);

      return (await this.list()).find(plugin => plugin.id === manifest.id);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async update(id, options = {}) {
    const installed = await this.installedPlugin(id);
    const registryUrl = options.registryUrl || this.registryUrl;
    const fetchFn = options.fetch || this.fetch;
    const fetchOpts = { signal: options.signal, timeoutMs: options.timeoutMs };
    const rawCatalog = options.catalog || JSON.parse(await fetchBoundedText(fetchFn, registryUrl, fetchOpts, MAX_CATALOG_SIZE));
    verifyRegistryCatalogSignature(rawCatalog, this.trustedRegistryKeys);
    const catalog = validateRegistryCatalog(rawCatalog);

    const entry = catalog.plugins.find(item => item.id === id);
    if (!entry) throw new Error(`Plugin ${id} not found in registry catalog`);

    const comparison = compareSemver(entry.version, installed.manifest.version);
    if (comparison <= 0 && !options.force) {
      return {
        updated: false,
        id,
        currentVersion: installed.manifest.version,
        availableVersion: entry.version,
        message: `Plugin ${id} is already up to date at version ${installed.manifest.version}`,
      };
    }

    return this.installFromRegistry(id, { ...options, catalog: rawCatalog });
  }

  async setEnabled(id, enabled) {
    await this.installedPlugin(id);
    const state = await this.readState();
    state.plugins[id] = { ...(state.plugins[id] ?? {}), enabled: Boolean(enabled), updatedAt: Date.now() };
    await this.writeState(state);
    return (await this.list()).find(plugin => plugin.id === id);
  }

  async invoke(id, method, params = {}, options = {}) {
    const { directory, manifest } = await this.installedPlugin(id);
    assertPluginTrust(manifest, { developerMode: this.developerMode, trustedKeys: this.trustedKeys });
    const state = await this.readState();
    if (state.plugins[id]?.enabled === false && !options.allowDisabled) throw new Error(`Plugin ${id} is disabled`);
    if (!isPluginCompatible(manifest)) throw new Error(`Plugin ${id} is not compatible with this system`);
    return invokePluginProcess({
      appDataDirectory: this.appDataDirectory,
      directory,
      manifest,
      method,
      params,
      configuration: options.configuration,
      secrets: options.secrets,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      files: options.files,
      fileLimits: options.fileLimits,
    });
  }

  async health(id) {
    const { manifest } = await this.installedPlugin(id);
    const startedAt = Date.now();
    try {
      const invocation = await this.invoke(id, manifest.healthCheck.method, {}, {
        allowDisabled: true,
        timeoutMs: manifest.healthCheck.timeoutMs,
      });
      return { ok: true, result: invocation.result, durationMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
    }
  }

  async rollback(id) {
    await this.prepare();
    const current = await this.installedPlugin(id);
    const candidates = (await readdir(this.rollbackRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, timestamp: rollbackTimestamp(id, entry.name) }))
      .filter(entry => entry.timestamp !== undefined)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(entry => entry.name);
    if (!candidates.length) throw new Error(`No rollback version is available for ${id}`);
    const previous = join(this.rollbackRoot, candidates[0]);
    const currentBackup = join(this.rollbackRoot, `${id}--${current.manifest.version}--${Date.now()}`);
    await rename(current.directory, currentBackup);
    try { await rename(previous, current.directory); }
    catch (error) {
      await rename(currentBackup, current.directory).catch(() => {});
      throw error;
    }
    const restored = await this.installedPlugin(id);
    const state = await this.readState();
    state.plugins[id] = { ...(state.plugins[id] ?? {}), version: restored.manifest.version, enabled: false, rolledBackAt: Date.now() };
    await this.writeState(state);
    return { id, version: restored.manifest.version, enabled: false };
  }

  async remove(id) {
    await this.prepare();
    const installed = await this.installedPlugin(id);
    const recoveryPath = join(this.removedRoot, `${id}--${installed.manifest.version}--${Date.now()}--${randomUUID()}`);
    await rename(installed.directory, recoveryPath);
    const state = await this.readState();
    delete state.plugins[id];
    await this.writeState(state);
    return { id, removed: true, recoveryPath: normalize(recoveryPath) };
  }
}
