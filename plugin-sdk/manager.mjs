import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import {
  assertPluginTrust, isPluginCompatible, loadPluginManifest, validatePluginPath,
} from './manifest.mjs';
import { invokePluginProcess } from './runtime.mjs';

const stateVersion = 1;

const parseTrustedKeys = environment => {
  if (!environment.QUIZZER_PLUGIN_TRUSTED_KEYS) return {};
  let keys;
  try { keys = JSON.parse(environment.QUIZZER_PLUGIN_TRUSTED_KEYS); }
  catch { throw new Error('QUIZZER_PLUGIN_TRUSTED_KEYS must be a JSON object'); }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)
    || Object.values(keys).some(value => typeof value !== 'string')) throw new Error('QUIZZER_PLUGIN_TRUSTED_KEYS must map key ids to public keys');
  return keys;
};

export class PluginManager {
  constructor({ appDataDirectory, developerMode = false, trustedKeys = parseTrustedKeys(process.env) }) {
    if (typeof appDataDirectory !== 'string' || !appDataDirectory) throw new Error('Plugin app-data directory is required');
    this.appDataDirectory = appDataDirectory;
    this.developerMode = developerMode;
    this.trustedKeys = trustedKeys;
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
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          capabilities: manifest.capabilities,
          resources: manifest.resources,
          permissions: manifest.permissions,
          enabled: saved.enabled !== false && !blocked,
          trust: saved.trust ?? (manifest.signature ? 'signed' : 'unsigned-local'),
          compatible: isPluginCompatible(manifest),
          warning: blocked ?? saved.warning,
          installedAt: saved.installedAt,
          status: blocked ? 'blocked' : 'installed',
          rollbackAvailable: rollbackEntries.some(rollback => rollback.isDirectory() && rollback.name.startsWith(`${manifest.id}--`)),
        };
      } catch (error) {
        return { id: entry.name, enabled: false, compatible: false, status: 'broken', error: error instanceof Error ? error.message : String(error) };
      }
    }));
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

  async install(source) {
    await this.prepare();
    const sourceDirectory = resolve(source);
    const manifest = await loadPluginManifest(sourceDirectory);
    if (!isPluginCompatible(manifest)) throw new Error(`Plugin ${manifest.id} does not support ${process.platform}/${process.arch}`);
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
      .filter(entry => entry.isDirectory() && entry.name.startsWith(`${id}--`))
      .map(entry => entry.name)
      .sort().reverse();
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
    state.plugins[id] = { ...(state.plugins[id] ?? {}), enabled: false, rolledBackAt: Date.now() };
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
