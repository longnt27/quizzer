import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

export const PLUGIN_SCHEMA_VERSION = 1;
export const PLUGIN_PROTOCOL_VERSION = 1;
export const PLUGIN_CAPABILITIES = Object.freeze(['extractor', 'ocr', 'embedder', 'vector-index', 'reranker', 'generator']);
const supportedOperatingSystems = new Set(['darwin', 'linux', 'win32']);
const supportedArchitectures = new Set(['x64', 'arm64']);
const supportedFilesystemPermissions = new Set(['scoped-temp', 'document-read', 'model-read']);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const pluginId = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const secretName = /^[A-Z][A-Z0-9_]{1,63}$/;

const requireObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};

const requireString = (value, label, maximum = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label} must be a non-empty string`);
  return value;
};

export const validatePluginPath = value => {
  requireString(value, 'Plugin path');
  if (isAbsolute(value) || value.includes('\\') || value.includes('\0')) throw new Error(`Unsafe plugin path: ${value}`);
  const normalized = normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith(`.${sep}`)) throw new Error(`Unsafe plugin path: ${value}`);
  return normalized;
};

export const validatePluginManifest = input => {
  const manifest = requireObject(input, 'Plugin manifest');
  if (manifest.schemaVersion !== PLUGIN_SCHEMA_VERSION) throw new Error(`Unsupported plugin schema version: ${manifest.schemaVersion}`);
  if (manifest.protocolVersion !== PLUGIN_PROTOCOL_VERSION) throw new Error(`Unsupported plugin protocol version: ${manifest.protocolVersion}`);
  if (!pluginId.test(manifest.id ?? '')) throw new Error('Plugin id is invalid');
  requireString(manifest.name, 'Plugin name', 100);
  if (manifest.description !== undefined && (typeof manifest.description !== 'string' || manifest.description.length > 500)) throw new Error('Plugin description is invalid');
  if (!semver.test(manifest.version ?? '')) throw new Error('Plugin version must use semantic versioning');
  const entrypoint = validatePluginPath(manifest.entrypoint);

  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.length
    || manifest.capabilities.some(capability => !PLUGIN_CAPABILITIES.includes(capability))
    || new Set(manifest.capabilities).size !== manifest.capabilities.length) throw new Error('Plugin capabilities are invalid');
  if (!Array.isArray(manifest.platforms) || !manifest.platforms.length) throw new Error('Plugin platforms are required');
  for (const platform of manifest.platforms) {
    requireObject(platform, 'Plugin platform');
    if (!supportedOperatingSystems.has(platform.os)) throw new Error(`Unsupported plugin operating system: ${platform.os}`);
    if (!Array.isArray(platform.architectures) || !platform.architectures.length
      || platform.architectures.some(architecture => !supportedArchitectures.has(architecture))) throw new Error('Plugin architectures are invalid');
  }

  const resources = requireObject(manifest.resources, 'Plugin resources');
  for (const key of ['memoryMB', 'diskMB']) {
    if (!Number.isSafeInteger(resources[key]) || resources[key] < 0) throw new Error(`Plugin ${key} must be a non-negative integer`);
  }
  if (resources.accelerators !== undefined && (!Array.isArray(resources.accelerators)
    || resources.accelerators.some(item => !['cpu', 'metal', 'cuda', 'rocm'].includes(item)))) throw new Error('Plugin accelerators are invalid');
  requireObject(manifest.configuration, 'Plugin configuration');

  const permissions = requireObject(manifest.permissions, 'Plugin permissions');
  if (!Array.isArray(permissions.network) || permissions.network.some(item => typeof item !== 'string' || !item)) throw new Error('Plugin network permissions are invalid');
  if (!Array.isArray(permissions.filesystem) || permissions.filesystem.some(item => !supportedFilesystemPermissions.has(item))) throw new Error('Plugin filesystem permissions are invalid');
  if (!Array.isArray(permissions.secrets) || permissions.secrets.some(item => !secretName.test(item))) throw new Error('Plugin secret permissions are invalid');
  if (typeof permissions.subprocess !== 'boolean') throw new Error('Plugin subprocess permission must be true or false');

  const healthCheck = requireObject(manifest.healthCheck, 'Plugin health check');
  requireString(healthCheck.method, 'Plugin health-check method', 100);
  if (!Number.isSafeInteger(healthCheck.timeoutMs) || healthCheck.timeoutMs < 100 || healthCheck.timeoutMs > 60_000) throw new Error('Plugin health-check timeout must be from 100 to 60000 ms');

  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Plugin files are required');
  const filePaths = new Set();
  for (const file of manifest.files) {
    requireObject(file, 'Plugin file');
    const path = validatePluginPath(file.path);
    if (filePaths.has(path)) throw new Error(`Duplicate plugin file: ${path}`);
    if (!sha256Pattern.test(file.sha256 ?? '')) throw new Error(`Invalid SHA-256 for plugin file: ${path}`);
    filePaths.add(path);
  }
  if (!filePaths.has(entrypoint)) throw new Error('Plugin entrypoint must be included in files');

  if (manifest.signature !== undefined) {
    const signature = requireObject(manifest.signature, 'Plugin signature');
    if (signature.algorithm !== 'ed25519') throw new Error('Only Ed25519 plugin signatures are supported');
    requireString(signature.keyId, 'Plugin signature key id', 100);
    requireString(signature.value, 'Plugin signature value', 1000);
  }
  return manifest;
};

const canonicalize = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const pluginSignaturePayload = manifest => {
  const unsigned = { ...validatePluginManifest(manifest) };
  delete unsigned.signature;
  return Buffer.from(canonicalize(unsigned));
};

const publicKeyFrom = value => value.includes('BEGIN PUBLIC KEY')
  ? createPublicKey(value)
  : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });

export const verifyPluginSignature = (manifest, trustedKeys) => {
  validatePluginManifest(manifest);
  if (!manifest.signature) return false;
  const value = trustedKeys?.[manifest.signature.keyId];
  if (!value) throw new Error(`Plugin signing key is not trusted: ${manifest.signature.keyId}`);
  const valid = verify(null, pluginSignaturePayload(manifest), publicKeyFrom(value), Buffer.from(manifest.signature.value, 'base64'));
  if (!valid) throw new Error('Plugin signature verification failed');
  return true;
};

export const verifyPluginFiles = async (directory, manifest) => {
  validatePluginManifest(manifest);
  const root = normalize(directory);
  for (const file of manifest.files) {
    const path = join(root, validatePluginPath(file.path));
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`Plugin file escapes its directory: ${file.path}`);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Plugin file must be a regular file: ${file.path}`);
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== file.sha256) throw new Error(`Plugin file hash mismatch: ${file.path}`);
  }
  return true;
};

export const loadPluginManifest = async (directory, { verifyFiles = true } = {}) => {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'quizzer.plugin.json'), 'utf8')); }
  catch (error) { throw new Error(`Could not read quizzer.plugin.json: ${error instanceof Error ? error.message : String(error)}`); }
  validatePluginManifest(manifest);
  if (verifyFiles) await verifyPluginFiles(directory, manifest);
  return manifest;
};

export const assertPluginTrust = (manifest, { developerMode = false, trustedKeys = {} } = {}) => {
  if (manifest.signature) {
    verifyPluginSignature(manifest, trustedKeys);
    return 'signed';
  }
  if (!developerMode) throw new Error('Unsigned plugins require Advanced Developer Mode');
  return 'unsigned-local';
};

export const isPluginCompatible = (manifest, { platform = process.platform, architecture = process.arch } = {}) =>
  manifest.platforms.some(target => target.os === platform && target.architectures.includes(architecture));
