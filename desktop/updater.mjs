import { createHash, createPublicKey, KeyObject, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { verifyReleaseManifestSignature } from '../release/manifest.mjs';
import { isValidArtifactName, MAX_DESKTOP_PACKAGE_SIZE, validateReleaseManifest } from '../server/release-manifest.mjs';

export const SUPPORTED_CHANNELS = Object.freeze(['stable', 'beta']);
export const CANONICAL_REPOSITORY = 'Somethings1/quizzer';
export const MAX_METADATA_BYTES = 1024 * 1024; // 1 MiB

const writeAll = async (fileHandle, bytes) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await fileHandle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error('Unable to make progress while writing the update artifact');
    }
    offset += bytesWritten;
  }
};

export const detectPlatform = (platform = process.platform) => {
  if (platform === 'darwin' || platform === 'macos') return 'macos';
  if (platform === 'win32' || platform === 'windows') return 'windows';
  if (platform === 'linux') return 'linux';
  return platform;
};

export const detectArch = (arch = process.arch) => {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  return arch;
};

export const parseSemver = version => {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : null,
    raw: version,
  };
};

export const compareSemver = (v1, v2) => {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (!p1 || !p2) throw new Error(`Invalid semver comparison: "${v1}" vs "${v2}"`);

  if (p1.major !== p2.major) return p1.major > p2.major ? 1 : -1;
  if (p1.minor !== p2.minor) return p1.minor > p2.minor ? 1 : -1;
  if (p1.patch !== p2.patch) return p1.patch > p2.patch ? 1 : -1;

  if (!p1.prerelease && !p2.prerelease) return 0;
  if (!p1.prerelease && p2.prerelease) return 1;
  if (p1.prerelease && !p2.prerelease) return -1;

  const length = Math.max(p1.prerelease.length, p2.prerelease.length);
  for (let i = 0; i < length; i++) {
    const id1 = p1.prerelease[i];
    const id2 = p2.prerelease[i];
    if (id1 === undefined) return -1;
    if (id2 === undefined) return 1;
    if (id1 === id2) continue;

    const num1 = /^\d+$/.test(id1) ? Number(id1) : null;
    const num2 = /^\d+$/.test(id2) ? Number(id2) : null;

    if (num1 !== null && num2 !== null) {
      return num1 > num2 ? 1 : -1;
    }
    if (num1 !== null && num2 === null) {
      return -1;
    }
    if (num1 === null && num2 !== null) {
      return 1;
    }
    return id1.localeCompare(id2);
  }
  return 0;
};

export const resolveReleaseChannel = (version, explicitChannel) => {
  if (explicitChannel) {
    if (!SUPPORTED_CHANNELS.includes(explicitChannel)) {
      throw new Error(`Invalid update channel: ${explicitChannel}. Must be stable or beta.`);
    }
    return explicitChannel;
  }
  if (typeof version === 'string' && version.includes('-')) {
    return 'beta';
  }
  return 'stable';
};

export const isValidReleaseTag = tag => {
  if (typeof tag !== 'string' || !tag || tag.length > 64) return false;
  if (tag.includes('/') || tag.includes('\\') || tag.includes('..')) return false;
  if (/[\x00-\x1f\x7f-\x9f]/.test(tag)) return false;
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag);
};

export const validateCanonicalReleaseUrl = (urlValue, repository = CANONICAL_REPOSITORY) => {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;

    if (url.hostname === 'github.com') {
      const canonicalPrefix = `/${repository}/releases/`;
      return url.pathname.startsWith(canonicalPrefix);
    }
    if (url.hostname === 'api.github.com') {
      const apiPrefix = `/repos/${repository}/releases`;
      return url.pathname === apiPrefix || url.pathname.startsWith(`${apiPrefix}/`);
    }
    return false;
  } catch {
    return false;
  }
};

export const fetchBoundedText = async (fetchFn, url, options = {}, maxBytes = MAX_METADATA_BYTES) => {
  const response = await fetchFn(url, options);
  if (!response.ok) {
    throw new Error(`Failed to fetch metadata from ${url}: HTTP ${response.status}`);
  }
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Response from ${url} exceeded maximum metadata size (${contentLength} > ${maxBytes})`);
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new Error(`Response from ${url} exceeded maximum metadata size of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Response from ${url} exceeded maximum metadata size of ${maxBytes} bytes`);
    }
    return text;
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Response from ${url} exceeded maximum metadata size of ${maxBytes} bytes`);
    }
    return buffer.toString('utf8');
  }
  throw new Error('Unsupported response body format');
};

const FORMAT_PREFERENCES = {
  macos: ['pkg', 'dmg', 'zip'],
  windows: ['msi', 'exe', 'zip'],
  linux: ['deb', 'rpm', 'appimage', 'tar.gz', 'zip'],
};

export const selectTargetArtifact = (artifacts, { platform = process.platform, architecture = process.arch, preferredFormat } = {}) => {
  if (!Array.isArray(artifacts) || !artifacts.length) return null;
  const targetPlatform = detectPlatform(platform);
  const targetArch = detectArch(architecture);

  const candidates = artifacts.filter(a =>
    a &&
    typeof a === 'object' &&
    a.platform === targetPlatform &&
    a.architecture === targetArch &&
    !a.cli,
  );
  if (!candidates.length) return null;

  if (preferredFormat) {
    const matched = candidates.find(a => a.format === preferredFormat);
    if (matched) return matched;
  }

  const preferences = FORMAT_PREFERENCES[targetPlatform] || [];
  for (const fmt of preferences) {
    const matched = candidates.find(a => a.format === fmt);
    if (matched) return matched;
  }
  return candidates[0];
};

export const selectStagedArtifact = (artifacts, selectedArtifactName, { platform = process.platform, architecture = process.arch } = {}) => {
  if (!isValidArtifactName(selectedArtifactName)) {
    throw new Error(`Invalid selected staged artifact name: "${selectedArtifactName}"`);
  }

  const targetPlatform = detectPlatform(platform);
  const targetArch = detectArch(architecture);
  const matches = Array.isArray(artifacts)
    ? artifacts.filter(artifact =>
        artifact &&
        typeof artifact === 'object' &&
        artifact.name === selectedArtifactName &&
        artifact.platform === targetPlatform &&
        artifact.architecture === targetArch &&
        !artifact.cli,
      )
    : [];

  if (matches.length !== 1) {
    throw new Error(
      `Selected staged artifact must match exactly one signed desktop artifact for ${targetPlatform}/${targetArch}`,
    );
  }

  return matches[0];
};

const readBoundedLocalText = async (filePath, maxBytes, label) => {
  const fileInfo = await lstat(filePath);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (fileInfo.size > maxBytes) {
    throw new Error(`${label} exceeded maximum size (${fileInfo.size} > ${maxBytes})`);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytesRead = 0;
    const stream = createReadStream(filePath);

    stream.on('data', chunk => {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        stream.destroy(new Error(`${label} exceeded maximum size of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
};

const verifyStagedArtifactFile = async (filePath, artifact) => {
  let fileInfo;
  try {
    fileInfo = await lstat(filePath);
  } catch (error) {
    throw new Error(`Staged artifact file not found: ${error.message}`);
  }

  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error('Staged artifact must be a regular file and cannot be a symbolic link');
  }
  if (fileInfo.size !== artifact.size) {
    throw new Error(`Staged artifact file size tampered: expected ${artifact.size}, found ${fileInfo.size}`);
  }

  const hasher = createHash('sha256');
  let bytesRead = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => {
      bytesRead += chunk.length;
      if (bytesRead > artifact.size) {
        stream.destroy(new Error(`Staged artifact exceeded signed size: ${bytesRead} > ${artifact.size}`));
        return;
      }
      hasher.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  if (bytesRead !== artifact.size) {
    throw new Error(`Staged artifact file size tampered: expected ${artifact.size}, found ${bytesRead}`);
  }
  const actualSha = hasher.digest('hex');
  if (actualSha !== artifact.sha256) {
    throw new Error(`Staged artifact checksum tampered: expected ${artifact.sha256}, found ${actualSha}`);
  }
};

const parseStagedMetadata = content => {
  let stagedData;
  try {
    stagedData = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid staged update metadata JSON: ${error.message}`);
  }

  if (!stagedData || typeof stagedData !== 'object' || Array.isArray(stagedData)) {
    throw new Error('Staged update metadata must be an object');
  }

  const allowedKeys = new Set(['stagedAt', 'manifest', 'selectedArtifactName']);
  const unexpectedKeys = Object.keys(stagedData).filter(key => !allowedKeys.has(key));
  if (unexpectedKeys.length) {
    throw new Error(`Staged update metadata contains unknown fields: ${unexpectedKeys.join(', ')}`);
  }
  if (typeof stagedData.stagedAt !== 'string' || Number.isNaN(Date.parse(stagedData.stagedAt))) {
    throw new Error('Staged update metadata has an invalid stagedAt timestamp');
  }
  if (!stagedData.manifest || typeof stagedData.manifest !== 'object' || Array.isArray(stagedData.manifest)) {
    throw new Error('Staged update metadata is missing its signed manifest');
  }
  if (!isValidArtifactName(stagedData.selectedArtifactName)) {
    throw new Error('Staged update metadata has an invalid selectedArtifactName');
  }

  return stagedData;
};

const rollbackCandidateIdPattern = /^candidate-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ROLLBACK_CANDIDATES = 3;
const MAX_ROLLBACK_SCAN = 16;

const parseRollbackPointer = content => {
  let pointer;
  try { pointer = JSON.parse(content); }
  catch (error) { throw new Error(`Invalid rollback metadata JSON: ${error.message}`); }
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) throw new Error('Rollback metadata must be an object');
  const unexpectedKeys = Object.keys(pointer).filter(key => key !== 'candidateId');
  if (unexpectedKeys.length) throw new Error(`Rollback metadata contains unknown fields: ${unexpectedKeys.join(', ')}`);
  if (!rollbackCandidateIdPattern.test(pointer.candidateId)) throw new Error('Rollback metadata has an invalid candidateId');
  return pointer;
};

const parseRollbackCandidateMetadata = content => {
  let metadata;
  try { metadata = JSON.parse(content); }
  catch (error) { throw new Error(`Invalid rollback candidate JSON: ${error.message}`); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Rollback candidate metadata must be an object');
  const allowedKeys = new Set(['candidateId', 'retainedAt', 'manifest', 'selectedArtifactName']);
  const unexpectedKeys = Object.keys(metadata).filter(key => !allowedKeys.has(key));
  if (unexpectedKeys.length) throw new Error(`Rollback candidate metadata contains unknown fields: ${unexpectedKeys.join(', ')}`);
  if (!rollbackCandidateIdPattern.test(metadata.candidateId)) throw new Error('Rollback candidate metadata has an invalid candidateId');
  if (typeof metadata.retainedAt !== 'string' || Number.isNaN(Date.parse(metadata.retainedAt))) {
    throw new Error('Rollback candidate metadata has an invalid retainedAt timestamp');
  }
  if (!metadata.manifest || typeof metadata.manifest !== 'object' || Array.isArray(metadata.manifest)) {
    throw new Error('Rollback candidate metadata is missing its signed manifest');
  }
  if (!isValidArtifactName(metadata.selectedArtifactName)) {
    throw new Error('Rollback candidate metadata has an invalid selectedArtifactName');
  }
  return metadata;
};

const atomicWriteJson = async (path, value) => {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await rename(tempPath, path);
    } catch (error) {
      // rename(2) replaces atomically on POSIX. Windows refuses to replace an
      // existing file, so remove only the old metadata after the new file is
      // complete, then perform the short handoff.
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await rm(path, { force: true });
      await rename(tempPath, path);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
};

export const normalizePublicKey = value => {
  if (!value) return null;
  if (value instanceof KeyObject) {
    if (value.type !== 'public') throw new Error('KeyObject must be of type public');
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('-----BEGIN')) {
      return createPublicKey(trimmed);
    }
    try {
      return createPublicKey({
        key: Buffer.from(trimmed, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      return createPublicKey(trimmed);
    }
  }
  if (typeof value === 'object' && value.kty === 'OKP' && value.crv === 'Ed25519') {
    return createPublicKey({ key: value, format: 'jwk' });
  }
  throw new Error('Unsupported public key format');
};

// Strict allowlists for automatic installer handoff per platform.
// Only well-known, platform-native installer formats that can be safely
// opened without shell interpolation are included.
export const HANDOFF_ALLOWLIST = Object.freeze({
  macos: Object.freeze(['pkg', 'dmg']),
  windows: Object.freeze(['exe', 'msi']),
  linux: Object.freeze(['deb', 'rpm', 'appimage']),
});

export const isAutoHandoffSupported = (platform, format) => {
  const allowed = HANDOFF_ALLOWLIST[platform];
  return Array.isArray(allowed) && allowed.includes(format);
};

export const resolveHandoffLaunch = (filePath, format, platform) => {
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('Installer handoff requires a verified package path');
  }
  if (!isAutoHandoffSupported(platform, format)) {
    throw new Error(`Unsupported format for automatic handoff on ${platform}: ${format}`);
  }

  if (platform === 'macos') {
    return { command: '/usr/bin/open', args: [filePath] };
  }
  if (platform === 'windows') {
    return format === 'exe'
      ? { command: filePath, args: [] }
      : { command: 'C:\\Windows\\System32\\msiexec.exe', args: ['/i', filePath] };
  }
  return { command: '/usr/bin/xdg-open', args: [filePath] };
};

export const defaultLauncher = async (filePath, format, platform) => {
  const { command, args } = resolveHandoffLaunch(filePath, format, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      shell: false,
    });

    let settled = false;
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to launch installer: ${err.message}`));
      }
    });

    child.on('spawn', () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });
  });
};

export class DesktopUpdater {
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || '';
    this.currentVersion = options.currentVersion || '1.0.0-beta.5';
    this.platform = detectPlatform(options.platform || process.platform);
    this.architecture = detectArch(options.architecture || process.arch);
    this.repository = CANONICAL_REPOSITORY;
    this.isPackaged = options.isPackaged ?? false;
    this.fetch = options.fetch || globalThis.fetch;
    this.launcher = options.launcher || defaultLauncher;

    this.channel = this.loadPersistedChannelSync(options.channel);

    this.trustedKeys = new Map();
    if (options.trustedKeys) {
      if (options.trustedKeys instanceof Map) {
        for (const [id, key] of options.trustedKeys.entries()) {
          this.trustedKeys.set(id, normalizePublicKey(key));
        }
      } else if (typeof options.trustedKeys === 'object') {
        for (const [id, key] of Object.entries(options.trustedKeys)) {
          this.trustedKeys.set(id, normalizePublicKey(key));
        }
      }
    }

    if (process.env.QUIZZER_RELEASE_PUBLIC_KEY) {
      const envKeyId = process.env.QUIZZER_RELEASE_PUBLIC_KEY_ID || 'default';
      try {
        this.trustedKeys.set(envKeyId, normalizePublicKey(process.env.QUIZZER_RELEASE_PUBLIC_KEY));
      } catch {
        // Leave unconfigured if environment key is malformed
      }
    }

    this.state = 'idle';
    this.updateInfo = null;
    this.downloadProgress = null;
    this.stagedArtifactName = null;
    this.rawVerifiedManifest = null;
    this.lastError = null;
    this.stagedRecoveryAttempted = false;
    this.stagedRecoveredFromDisk = false;
    this.operationInFlight = null;
  }

  assertNoOperation(operation) {
    if (this.operationInFlight) {
      throw new Error(`Cannot ${operation} while ${this.operationInFlight} is in progress`);
    }
  }

  loadPersistedChannelSync(fallbackOptionChannel) {
    if (this.userDataDir) {
      try {
        const channelFile = join(this.userDataDir, 'updates', 'channel.json');
        const content = readFileSync(channelFile, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && SUPPORTED_CHANNELS.includes(parsed.channel)) {
          return parsed.channel;
        }
      } catch {
        // Fall back to configured channel or version default
      }
    }
    return resolveReleaseChannel(this.currentVersion, fallbackOptionChannel);
  }

  async persistChannel(channel) {
    if (!this.userDataDir) return;
    const updatesDir = join(this.userDataDir, 'updates');
    await mkdir(updatesDir, { recursive: true, mode: 0o700 });
    const channelFile = join(updatesDir, 'channel.json');
    const tempFile = `${channelFile}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ channel, updatedAt: new Date().toISOString() }, null, 2);
    await writeFile(tempFile, `${payload}\n`, { mode: 0o600 });
    await rename(tempFile, channelFile);
  }

  resolvePublicKey(publicKeyId) {
    return this.trustedKeys.get(publicKeyId) || null;
  }

  getKeyStatus() {
    if (!this.trustedKeys.size) {
      return {
        configured: false,
        algorithm: 'ed25519',
        trusted: false,
        message: 'No production release public key configured',
      };
    }
    const ids = [...this.trustedKeys.keys()];
    return {
      configured: true,
      id: ids.length === 1 ? ids[0] : ids.join(', '),
      algorithm: 'ed25519',
      trusted: true,
    };
  }

  async setChannel(channel) {
    if (!SUPPORTED_CHANNELS.includes(channel)) {
      throw new Error(`Invalid channel "${channel}". Supported channels: ${SUPPORTED_CHANNELS.join(', ')}`);
    }
    this.channel = channel;
    await this.persistChannel(channel);
    this.state = 'idle';
    this.updateInfo = null;
    this.lastError = null;
    return this.getStatus();
  }

  rollbackPaths() {
    const rollbackRoot = join(this.userDataDir, 'updates', 'rollback');
    return {
      rollbackRoot,
      rollbackPointerPath: join(rollbackRoot, 'rollback.json'),
    };
  }

  async loadRollbackCandidate({ verifyArtifact = true } = {}) {
    if (!this.userDataDir) throw new Error('User data directory not configured');
    const { rollbackRoot, rollbackPointerPath } = this.rollbackPaths();
    let pointer;
    try {
      pointer = parseRollbackPointer(await readBoundedLocalText(
        rollbackPointerPath,
        MAX_METADATA_BYTES,
        'Rollback metadata',
      ));
    } catch (error) {
      // The pointer is a cache, not the source of truth. A crash between
      // writing the candidate and its pointer must remain recoverable.
      if (error?.code !== 'ENOENT') throw error;
    }
    const entries = await readdir(rollbackRoot, { withFileTypes: true });
    const candidateIds = entries
      .filter(entry => entry.isDirectory() && rollbackCandidateIdPattern.test(entry.name))
      .map(entry => entry.name);
    candidateIds.sort((left, right) => right.localeCompare(left));
    const candidatesToScan = candidateIds.slice(0, MAX_ROLLBACK_SCAN);
    if (pointer && !candidatesToScan.includes(pointer.candidateId)) candidatesToScan.push(pointer.candidateId);

    const validCandidates = [];
    let lastError;
    for (const candidateId of candidatesToScan) {
      const candidateDir = join(rollbackRoot, candidateId);
      if (dirname(candidateDir) !== rollbackRoot) {
        lastError = new Error('Rollback candidate path escapes rollback directory');
        continue;
      }
      try {
        const metadata = parseRollbackCandidateMetadata(await readBoundedLocalText(
          join(candidateDir, 'rollback-candidate.json'),
          MAX_METADATA_BYTES,
          'Rollback candidate metadata',
        ));
        if (metadata.candidateId !== candidateId) throw new Error('Rollback candidate metadata does not match candidate directory');
        const manifest = await this.verifyManifest(metadata.manifest);
        const artifact = selectStagedArtifact(manifest.artifacts, metadata.selectedArtifactName, {
          platform: this.platform,
          architecture: this.architecture,
        });
        const artifactPath = join(candidateDir, artifact.name);
        if (dirname(artifactPath) !== candidateDir) throw new Error('Derived rollback artifact path escapes candidate directory');
        if (verifyArtifact) {
          await verifyStagedArtifactFile(artifactPath, artifact);
        } else {
          const artifactFile = await lstat(artifactPath);
          if (!artifactFile.isFile() || artifactFile.isSymbolicLink()) throw new Error('Rollback artifact must be a regular file and cannot be a symbolic link');
          if (artifactFile.size !== artifact.size) throw new Error(`Rollback artifact file size tampered: expected ${artifact.size}, found ${artifactFile.size}`);
        }
        if (compareSemver(manifest.version, this.currentVersion) < 0) {
          validCandidates.push({ artifact, artifactPath, manifest, metadata });
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (validCandidates.length) {
      validCandidates.sort((left, right) => compareSemver(right.manifest.version, left.manifest.version));
      return validCandidates[0];
    }
    if (lastError) throw lastError;
    const error = new Error(`Rollback candidate is not older than current version ${this.currentVersion}`);
    error.code = 'ROLLBACK_NOT_OLDER';
    throw error;
  }

  async getRollbackInfo() {
    if (!this.userDataDir) return { available: false, status: 'unavailable', message: 'No rollback candidate is available' };
    try {
      // Status polling only verifies bounded metadata, signature, target and
      // file size. The expensive artifact hash is rechecked in rollbackUpdate.
      const candidate = await this.loadRollbackCandidate({ verifyArtifact: false });
      return {
        available: true,
        version: candidate.manifest.version,
        targetVersion: this.currentVersion,
        timestamp: candidate.metadata.retainedAt,
        status: 'metadata-verified',
        artifactName: candidate.artifact.name,
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ROLLBACK_NOT_OLDER') {
        return { available: false, status: 'unavailable', message: 'No rollback candidate is available' };
      }
      return {
        available: false,
        status: 'invalid',
        message: `Rollback candidate verification failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async retainRollbackCandidate({ artifact, manifest }) {
    if (!this.userDataDir) throw new Error('User data directory not configured');
    const stagingDir = join(this.userDataDir, 'updates', 'staging');
    const { rollbackRoot, rollbackPointerPath } = this.rollbackPaths();
    const verifiedManifest = await this.verifyManifest(manifest);
    const verifiedArtifact = selectStagedArtifact(verifiedManifest.artifacts, artifact.name, {
      platform: this.platform,
      architecture: this.architecture,
    });
    const candidateId = `candidate-${Date.now()}-${randomUUID()}`;
    const candidateDir = join(rollbackRoot, candidateId);
    const sourcePath = join(stagingDir, verifiedArtifact.name);
    const artifactPath = join(candidateDir, verifiedArtifact.name);
    if (dirname(artifactPath) !== candidateDir) throw new Error('Rollback artifact path escapes candidate directory');

    // The staged package was already verified by applyUpdate, but retain's
    // public boundary verifies it again before making a durable copy.
    await verifyStagedArtifactFile(sourcePath, verifiedArtifact);
    await mkdir(rollbackRoot, { recursive: true, mode: 0o700 });

    // Avoid duplicate copies when an installer handoff is retried.
    const entries = await readdir(rollbackRoot, { withFileTypes: true });
    const existingIds = entries
      .filter(entry => entry.isDirectory() && rollbackCandidateIdPattern.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left))
      .slice(0, MAX_ROLLBACK_SCAN);
    for (const existingId of existingIds) {
      const existingDir = join(rollbackRoot, existingId);
      if (dirname(existingDir) !== rollbackRoot) continue;
      try {
        const existingMetadata = parseRollbackCandidateMetadata(await readBoundedLocalText(
          join(existingDir, 'rollback-candidate.json'), MAX_METADATA_BYTES, 'Rollback candidate metadata',
        ));
        if (existingMetadata.candidateId !== existingId) continue;
        const existingManifest = await this.verifyManifest(existingMetadata.manifest);
        const existingArtifact = selectStagedArtifact(existingManifest.artifacts, existingMetadata.selectedArtifactName, {
          platform: this.platform,
          architecture: this.architecture,
        });
        if (existingManifest.version !== verifiedManifest.version || existingArtifact.sha256 !== verifiedArtifact.sha256) continue;
        await verifyStagedArtifactFile(join(existingDir, existingArtifact.name), existingArtifact);
        await atomicWriteJson(rollbackPointerPath, { candidateId: existingId });
        await this.pruneRollbackCandidates(existingId);
        return;
      } catch {
        // A corrupt duplicate is never reused; the newly verified package wins.
      }
    }

    await mkdir(candidateDir, { recursive: true, mode: 0o700 });
    const tempArtifactPath = join(candidateDir, `.${verifiedArtifact.name}.${randomUUID()}.tmp`);
    try {
      await copyFile(sourcePath, tempArtifactPath);
      await verifyStagedArtifactFile(tempArtifactPath, verifiedArtifact);
      await rename(tempArtifactPath, artifactPath);
      if (this.platform === 'linux' && verifiedArtifact.format === 'appimage') await chmod(artifactPath, 0o700);
      await atomicWriteJson(join(candidateDir, 'rollback-candidate.json'), {
        candidateId,
        retainedAt: new Date().toISOString(),
        manifest: verifiedManifest,
        selectedArtifactName: verifiedArtifact.name,
      });
      await atomicWriteJson(rollbackPointerPath, { candidateId });
      await this.pruneRollbackCandidates(candidateId);
    } catch (error) {
      await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(tempArtifactPath, { force: true }).catch(() => {});
    }
  }

  async pruneRollbackCandidates(protectedCandidateId) {
    if (!this.userDataDir) return;
    const { rollbackRoot } = this.rollbackPaths();
    let entries;
    try {
      entries = await readdir(rollbackRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const candidateIds = entries
      .filter(entry => entry.isDirectory() && rollbackCandidateIdPattern.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left));
    const validCandidates = [];
    for (const candidateId of candidateIds.slice(0, MAX_ROLLBACK_SCAN)) {
      const candidateDir = join(rollbackRoot, candidateId);
      if (dirname(candidateDir) !== rollbackRoot) continue;
      try {
        const metadata = parseRollbackCandidateMetadata(await readBoundedLocalText(
          join(candidateDir, 'rollback-candidate.json'), MAX_METADATA_BYTES, 'Rollback candidate metadata',
        ));
        if (metadata.candidateId !== candidateId) continue;
        const manifest = await this.verifyManifest(metadata.manifest);
        const candidateArtifact = selectStagedArtifact(manifest.artifacts, metadata.selectedArtifactName, {
          platform: this.platform,
          architecture: this.architecture,
        });
        validCandidates.push({ candidateId, manifest, metadata, candidateArtifact });
      } catch {
        // Never use an invalid candidate to influence the retained set.
      }
    }
    validCandidates.sort((left, right) => compareSemver(right.manifest.version, left.manifest.version)
      || Date.parse(right.metadata.retainedAt) - Date.parse(left.metadata.retainedAt));
    const keepIds = new Set();
    const seenVersions = new Set();
    const protectedCandidate = validCandidates.find(candidate => candidate.candidateId === protectedCandidateId);
    if (protectedCandidate) {
      keepIds.add(protectedCandidateId);
      seenVersions.add(`${protectedCandidate.manifest.version}:${protectedCandidate.candidateArtifact.sha256}`);
    } else if (candidateIds.includes(protectedCandidateId)) {
      // Never delete the freshly written protected directory if a transient
      // read error occurs while rotating older candidates.
      keepIds.add(protectedCandidateId);
    }
    for (const candidate of validCandidates) {
      if (keepIds.size >= MAX_ROLLBACK_CANDIDATES) break;
      const key = `${candidate.manifest.version}:${candidate.candidateArtifact.sha256}`;
      if (seenVersions.has(key)) continue;
      seenVersions.add(key);
      keepIds.add(candidate.candidateId);
    }
    for (const candidateId of candidateIds) {
      if (keepIds.has(candidateId)) continue;
      const candidateDir = join(rollbackRoot, candidateId);
      if (dirname(candidateDir) !== rollbackRoot) continue;
      await rm(candidateDir, { recursive: true, force: true });
    }
  }

  async loadStagedPackage() {
    if (!this.userDataDir) {
      throw new Error('User data directory not configured');
    }

    const stagingDir = join(this.userDataDir, 'updates', 'staging');
    const stagedMetadataPath = join(stagingDir, 'staged-update.json');
    const metadataText = await readBoundedLocalText(
      stagedMetadataPath,
      MAX_METADATA_BYTES,
      'Staged update metadata',
    );
    const stagedData = parseStagedMetadata(metadataText);
    const manifest = await this.verifyManifest(stagedData.manifest);
    const artifact = selectStagedArtifact(manifest.artifacts, stagedData.selectedArtifactName, {
      platform: this.platform,
      architecture: this.architecture,
    });

    const artifactPath = join(stagingDir, artifact.name);
    if (dirname(artifactPath) !== stagingDir) {
      throw new Error('Derived artifact path escapes staging directory');
    }
    await verifyStagedArtifactFile(artifactPath, artifact);

    return { artifact, manifest };
  }

  restoreStagedPackage({ artifact, manifest }) {
    this.state = 'downloaded';
    this.rawVerifiedManifest = manifest;
    this.stagedArtifactName = artifact.name;
    this.updateInfo = {
      version: manifest.version,
      channel: manifest.channel,
      publishedAt: manifest.publishedAt,
      publicKeyId: manifest.publicKeyId,
      artifact,
    };
    this.downloadProgress = {
      bytesDownloaded: artifact.size,
      totalBytes: artifact.size,
      percent: 100,
    };
    this.lastError = null;
  }

  async recoverStagedUpdate() {
    if (this.stagedRecoveryAttempted || this.state !== 'idle' || !this.userDataDir) return;
    this.stagedRecoveryAttempted = true;

    try {
      this.restoreStagedPackage(await this.loadStagedPackage());
      this.stagedRecoveredFromDisk = true;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      this.state = 'error';
      this.lastError = `Failed to recover staged update: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async getStatus() {
    await this.recoverStagedUpdate();
    const keyStatus = this.getKeyStatus();

    return {
      state: this.state,
      currentVersion: this.currentVersion,
      channel: this.channel,
      target: {
        platform: this.platform,
        architecture: this.architecture,
      },
      keyStatus,
      mechanism: this.state === 'manual-handoff'
        ? 'manual-handoff'
        : this.isPackaged ? 'staged-ready' : 'staged-development',
      supported: Boolean(this.userDataDir),
      updateInfo: this.updateInfo ? { ...this.updateInfo } : undefined,
      downloadProgress: this.downloadProgress ? { ...this.downloadProgress } : undefined,
      rollbackInfo: await this.getRollbackInfo(),
      stagedArtifactName: this.stagedArtifactName || undefined,
      error: this.lastError || undefined,
    };
  }

  async verifyManifest(manifestData) {
    let manifest;
    if (typeof manifestData === 'string') {
      try {
        manifest = JSON.parse(manifestData);
      } catch (err) {
        throw new Error(`Invalid release manifest JSON: ${err.message}`);
      }
    } else if (manifestData && typeof manifestData === 'object') {
      manifest = manifestData;
    } else {
      throw new Error('Release manifest must be a non-empty object or JSON string');
    }

    if (manifest.signatureAlgorithm !== 'ed25519') {
      throw new Error(`Unsupported signature algorithm: ${manifest.signatureAlgorithm}. Only ed25519 is accepted.`);
    }

    const publicKey = this.resolvePublicKey(manifest.publicKeyId);
    if (!publicKey) {
      if (!this.trustedKeys.size) {
        throw new Error('No trusted release public key configured. Refusing to trust unverified manifest.');
      }
      throw new Error(`Release manifest signed with untrusted publicKeyId: "${manifest.publicKeyId}"`);
    }

    if (!manifest.signature || typeof manifest.signature !== 'string') {
      throw new Error('Release manifest is missing signature');
    }

    const signatureValid = verifyReleaseManifestSignature(manifest, publicKey);
    if (!signatureValid) {
      throw new Error('Release manifest signature verification failed: signature does not match content');
    }

    const validation = validateReleaseManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Release manifest schema validation failed: ${validation.errors.join('; ')}`);
    }

    return manifest;
  }

  async checkForUpdates(options = {}) {
    this.assertNoOperation('check for updates');
    this.state = 'checking';
    this.lastError = null;

    try {
      if (options.channel && options.channel !== this.channel) {
        await this.setChannel(options.channel);
      }

      const channel = this.channel;
      const repository = CANONICAL_REPOSITORY;

      let manifestUrl;
      if (options.tag) {
        if (!isValidReleaseTag(options.tag)) {
          throw new Error(`Invalid release tag syntax: "${options.tag}"`);
        }
        manifestUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(options.tag)}/release-manifest.json`;
      } else if (channel === 'stable') {
        manifestUrl = `https://github.com/${repository}/releases/latest/download/release-manifest.json`;
      } else {
        // Beta must discover actual prereleases through canonical GitHub Releases API
        const apiUrl = `https://api.github.com/repos/${repository}/releases`;
        if (!validateCanonicalReleaseUrl(apiUrl, repository)) {
          throw new Error(`Untrusted release API URL: ${apiUrl}`);
        }

        const releasesJson = await fetchBoundedText(
          this.fetch,
          apiUrl,
          { headers: { 'User-Agent': `Quizzer-Desktop-Updater/${this.currentVersion}`, Accept: 'application/vnd.github+json' } },
          MAX_METADATA_BYTES,
        );

        let releases;
        try {
          releases = JSON.parse(releasesJson);
        } catch (err) {
          throw new Error(`Invalid GitHub Releases API response JSON: ${err.message}`);
        }
        if (!Array.isArray(releases)) {
          throw new Error('GitHub Releases API response must be an array');
        }

        const prereleases = releases.filter(r =>
          r &&
          typeof r === 'object' &&
          r.prerelease === true &&
          !r.draft &&
          typeof r.tag_name === 'string' &&
          isValidReleaseTag(r.tag_name),
        );

        if (!prereleases.length) {
          throw new Error('No valid prerelease found on beta channel');
        }

        prereleases.sort((a, b) => compareSemver(b.tag_name, a.tag_name));
        const selectedTag = prereleases[0].tag_name;
        manifestUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(selectedTag)}/release-manifest.json`;
      }

      if (!validateCanonicalReleaseUrl(manifestUrl, repository)) {
        throw new Error(`Untrusted release metadata URL: ${manifestUrl}`);
      }

      const manifestText = await fetchBoundedText(
        this.fetch,
        manifestUrl,
        { headers: { 'User-Agent': `Quizzer-Desktop-Updater/${this.currentVersion}` } },
        MAX_METADATA_BYTES,
      );

      const verifiedManifest = await this.verifyManifest(manifestText);
      this.rawVerifiedManifest = verifiedManifest;

      if (channel === 'stable' && verifiedManifest.channel !== 'stable') {
        this.state = 'up-to-date';
        this.updateInfo = null;
        return this.getStatus();
      }

      const targetArtifact = selectTargetArtifact(verifiedManifest.artifacts, {
        platform: this.platform,
        architecture: this.architecture,
        preferredFormat: options.preferredFormat,
      });

      if (!targetArtifact) {
        this.state = 'unsupported';
        this.lastError = `No supported desktop artifact found for ${this.platform}/${this.architecture} in release ${verifiedManifest.version}`;
        return this.getStatus();
      }

      if (!isValidArtifactName(targetArtifact.name)) {
        throw new Error(`Target artifact name is invalid: "${targetArtifact.name}"`);
      }
      if (targetArtifact.size > MAX_DESKTOP_PACKAGE_SIZE) {
        throw new Error(`Target artifact size exceeds maximum allowable package size (${targetArtifact.size} > ${MAX_DESKTOP_PACKAGE_SIZE})`);
      }

      const comparison = compareSemver(verifiedManifest.version, this.currentVersion);
      if (comparison <= 0 && !options.force) {
        this.state = 'up-to-date';
        this.updateInfo = null;
        return this.getStatus();
      }

      this.state = 'available';
      this.updateInfo = {
        version: verifiedManifest.version,
        channel: verifiedManifest.channel,
        publishedAt: verifiedManifest.publishedAt,
        publicKeyId: verifiedManifest.publicKeyId,
        artifact: targetArtifact,
      };

      return this.getStatus();
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.getStatus();
    }
  }

  async downloadUpdate() {
    this.assertNoOperation('download an update');
    if (this.state !== 'available' || !this.updateInfo) {
      throw new Error('No update is currently available to download');
    }

    this.state = 'downloading';
    this.stagedRecoveredFromDisk = false;
    this.downloadProgress = { bytesDownloaded: 0, totalBytes: this.updateInfo.artifact.size, percent: 0 };
    this.lastError = null;

    if (!this.userDataDir) {
      this.state = 'error';
      this.lastError = 'User data directory not configured';
      throw new Error(this.lastError);
    }

    const artifact = this.updateInfo.artifact;
    if (!isValidArtifactName(artifact.name)) {
      throw new Error(`Invalid artifact name: "${artifact.name}"`);
    }
    if (artifact.size > MAX_DESKTOP_PACKAGE_SIZE) {
      throw new Error(`Artifact size exceeds maximum allowable package size (${artifact.size} > ${MAX_DESKTOP_PACKAGE_SIZE})`);
    }

    const stagingDir = join(this.userDataDir, 'updates', 'staging');
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    const tempPath = join(stagingDir, `download-${Date.now()}-${artifact.name}.tmp`);
    const finalPath = join(stagingDir, artifact.name);
    if (dirname(finalPath) !== stagingDir) {
      throw new Error(`Artifact destination path escapes staging directory: ${artifact.name}`);
    }

    let fileHandle;
    try {
      fileHandle = await open(tempPath, 'w', 0o600);
      const hasher = createHash('sha256');
      let bytesReceived = 0;

      const response = await this.fetch(artifact.url, {
        headers: { 'User-Agent': `Quizzer-Desktop-Updater/${this.currentVersion}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to download artifact: HTTP ${response.status}`);
      }

      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesReceived += value.byteLength;
          if (bytesReceived > artifact.size) {
            throw new Error(`Downloaded artifact exceeded expected size: ${bytesReceived} > ${artifact.size}`);
          }
          hasher.update(value);
          await writeAll(fileHandle, value);
          this.downloadProgress = {
            bytesDownloaded: bytesReceived,
            totalBytes: artifact.size,
            percent: Math.min(100, Math.round((bytesReceived / artifact.size) * 100)),
          };
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        bytesReceived = buffer.length;
        if (bytesReceived > artifact.size) {
          throw new Error(`Downloaded artifact exceeded expected size: ${bytesReceived} > ${artifact.size}`);
        }
        hasher.update(buffer);
        await writeAll(fileHandle, buffer);
        this.downloadProgress = {
          bytesDownloaded: bytesReceived,
          totalBytes: artifact.size,
          percent: Math.min(100, Math.round((bytesReceived / artifact.size) * 100)),
        };
      }

      await fileHandle.close();
      fileHandle = undefined;

      if (bytesReceived !== artifact.size) {
        throw new Error(`Incomplete artifact download: expected ${artifact.size} bytes, got ${bytesReceived}`);
      }

      const calculatedSha256 = hasher.digest('hex');
      if (calculatedSha256 !== artifact.sha256) {
        throw new Error(`SHA-256 mismatch for artifact: expected ${artifact.sha256}, got ${calculatedSha256}`);
      }

      await rename(tempPath, finalPath);
      if (this.platform === 'linux' && artifact.format === 'appimage') {
        await chmod(finalPath, 0o700);
      }

      const stagedPayload = {
        stagedAt: new Date().toISOString(),
        manifest: this.rawVerifiedManifest,
        selectedArtifactName: artifact.name,
      };
      const stagedMetadataPath = join(stagingDir, 'staged-update.json');
      const tempMetaPath = `${stagedMetadataPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempMetaPath, `${JSON.stringify(stagedPayload, null, 2)}\n`, { mode: 0o600 });
      await rename(tempMetaPath, stagedMetadataPath);

      this.state = 'downloaded';
      this.stagedArtifactName = artifact.name;
      return this.getStatus();
    } catch (error) {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
      await rm(tempPath, { force: true }).catch(() => {});
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async applyUpdate(options = {}) {
    this.assertNoOperation('apply an update');
    this.operationInFlight = 'apply';
    try {
      if (!this.userDataDir) {
        throw new Error('User data directory not configured');
      }

      let stagedPackage;
      try {
        stagedPackage = await this.loadStagedPackage();
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error('No verified update is ready to apply');
        }
        throw error;
      }

      this.restoreStagedPackage(stagedPackage);
      this.state = 'applying';
      const { artifact: targetArtifact } = stagedPackage;

      const format = targetArtifact.format;
      const autoHandoff = isAutoHandoffSupported(this.platform, format);

      if (!this.isPackaged) {
        this.state = 'installer-handoff-pending';
        this.stagedArtifactName = targetArtifact.name;
        return {
          applied: false,
          handoffPending: true,
          restartRequested: false,
          mechanism: 'staged-development',
          message: 'Update verified and staged. In unpacked development mode, installer handoff is pending without binary execution.',
          status: await this.getStatus(),
        };
      }

      const artifactPath = join(this.userDataDir, 'updates', 'staging', targetArtifact.name);

      if (!autoHandoff) {
        this.state = 'manual-handoff';
        this.stagedArtifactName = targetArtifact.name;
        return {
          applied: false,
          handoffPending: true,
          restartRequested: false,
          mechanism: 'manual-handoff',
          message: `Update package format ${format} requires manual opening. The verified package remains in private update staging.`,
          status: await this.getStatus(),
        };
      }

      // Cache the verified target installer before launching it. This is the
      // package retained for a future rollback, not a claim about the version
      // left behind. A failed launcher may leave this harmless verified copy.
      try {
        await this.retainRollbackCandidate(stagedPackage);
      } catch (err) {
        this.state = 'error';
        this.lastError = `Installer was not launched because rollback candidate could not be retained: ${err instanceof Error ? err.message : String(err)}`;
        throw new Error(this.lastError);
      }

      try {
        await this.launcher(artifactPath, format, this.platform);
      } catch (err) {
        this.state = 'error';
        this.lastError = `Installer handoff failed: ${err instanceof Error ? err.message : String(err)}`;
        throw new Error(this.lastError);
      }

      this.state = 'installer-handoff-pending';
      this.stagedArtifactName = targetArtifact.name;

      return {
        applied: false,
        handoffPending: true,
        restartRequested: options.restart ?? false,
        mechanism: 'staged-ready',
        message: 'Update package cryptographically verified and successfully handed off to system installer.',
        status: await this.getStatus(),
      };
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.operationInFlight = null;
    }
  }

  async discardUpdate() {
    this.assertNoOperation('discard an update');
    if (this.userDataDir) {
      const stagingDir = join(this.userDataDir, 'updates', 'staging');
      try {
        const files = await readdir(stagingDir);
        for (const file of files) {
          await rm(join(stagingDir, file), { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        // Staging directory may not exist
      }
    }

    this.state = 'idle';
    this.updateInfo = null;
    this.downloadProgress = null;
    this.stagedArtifactName = null;
    this.rawVerifiedManifest = null;
    this.lastError = null;
    this.stagedRecoveryAttempted = true;
    this.stagedRecoveredFromDisk = false;

    return {
      discarded: true,
      status: await this.getStatus(),
    };
  }

  async rollbackUpdate() {
    this.assertNoOperation('roll back');
    const allowedStates = new Set(['idle', 'up-to-date', 'unsupported', 'error', 'manual-handoff', 'installer-handoff-pending']);
    const recoveredStagedHandoff = this.state === 'downloaded' && this.stagedRecoveredFromDisk;
    if (!allowedStates.has(this.state) && !recoveredStagedHandoff) {
      throw new Error(`Cannot roll back while updater state is ${this.state}`);
    }
    this.operationInFlight = 'rollback';
    try {
      return await this.performRollback();
    } finally {
      this.operationInFlight = null;
    }
  }

  async performRollback() {
    const rollbackInfo = await this.getRollbackInfo();
    if (!rollbackInfo.available) {
      this.state = 'idle';
      this.lastError = null;
      return {
        rolledBack: false,
        handoffPending: false,
        quitRequested: false,
        mechanism: 'unavailable',
        message: rollbackInfo.message || 'No verified rollback candidate is available.',
        status: await this.getStatus(),
      };
    }

    let candidate;
    try {
      candidate = await this.loadRollbackCandidate();
    } catch (error) {
      this.state = 'idle';
      this.lastError = null;
      return {
        rolledBack: false,
        handoffPending: false,
        quitRequested: false,
        mechanism: 'unavailable',
        message: `Rollback candidate is no longer available: ${error instanceof Error ? error.message : String(error)}`,
        status: await this.getStatus(),
      };
    }

    this.state = 'applying';
    this.updateInfo = {
      version: candidate.manifest.version,
      channel: candidate.manifest.channel,
      publishedAt: candidate.manifest.publishedAt,
      publicKeyId: candidate.manifest.publicKeyId,
      artifact: candidate.artifact,
    };
    this.downloadProgress = null;
    this.stagedArtifactName = null;
    this.lastError = null;

    if (!this.isPackaged) {
      this.state = 'idle';
      return {
        rolledBack: false,
        handoffPending: false,
        quitRequested: false,
        mechanism: 'staged-development',
        restoredVersion: candidate.manifest.version,
        message: 'Rollback candidate verified. In unpacked development mode, installer handoff is disabled.',
        status: await this.getStatus(),
      };
    }

    if (!isAutoHandoffSupported(this.platform, candidate.artifact.format)) {
      this.state = 'manual-handoff';
      return {
        rolledBack: false,
        handoffPending: false,
        quitRequested: false,
        mechanism: 'manual-handoff',
        restoredVersion: candidate.manifest.version,
        message: `Rollback package format ${candidate.artifact.format} requires manual opening. The verified rollback package remains in private storage.`,
        status: await this.getStatus(),
      };
    }

    try {
      await this.launcher(candidate.artifactPath, candidate.artifact.format, this.platform);
    } catch (error) {
      this.state = 'error';
      this.lastError = `Rollback installer handoff failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(this.lastError);
    }

    this.state = 'installer-handoff-pending';
    return {
      rolledBack: false,
      handoffPending: true,
      quitRequested: true,
      mechanism: 'staged-ready',
      restoredVersion: candidate.manifest.version,
      message: 'Verified rollback package was handed off to the system installer. Complete the installation in the system window that opened.',
      status: await this.getStatus(),
    };
  }
}
