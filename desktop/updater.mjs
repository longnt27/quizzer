import { createHash, createPublicKey, KeyObject } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalizeManifest, verifyReleaseManifestSignature } from '../release/manifest.mjs';
import { validateReleaseManifest } from '../server/release-manifest.mjs';

export const SUPPORTED_CHANNELS = Object.freeze(['stable', 'beta']);
export const CANONICAL_REPOSITORY = 'Somethings1/quizzer';

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

const FORMAT_PREFERENCES = {
  macos: ['zip', 'dmg'],
  windows: ['exe', 'zip'],
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

export class DesktopUpdater {
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || '';
    this.currentVersion = options.currentVersion || '1.0.0-beta.1';
    this.platform = detectPlatform(options.platform || process.platform);
    this.architecture = detectArch(options.architecture || process.arch);
    this.repository = options.repository || CANONICAL_REPOSITORY;
    this.isPackaged = options.isPackaged ?? false;
    this.fetch = options.fetch || globalThis.fetch;
    this.channel = resolveReleaseChannel(this.currentVersion, options.channel);

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
    this.stagedPath = null;
    this.lastError = null;
  }

  resolvePublicKey(publicKeyId) {
    if (this.trustedKeys.has(publicKeyId)) {
      return this.trustedKeys.get(publicKeyId);
    }
    if (this.trustedKeys.has('default') && this.trustedKeys.size === 1) {
      return this.trustedKeys.get('default');
    }
    return null;
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

  setChannel(channel) {
    if (!SUPPORTED_CHANNELS.includes(channel)) {
      throw new Error(`Invalid channel "${channel}". Supported channels: ${SUPPORTED_CHANNELS.join(', ')}`);
    }
    this.channel = channel;
    this.state = 'idle';
    this.updateInfo = null;
    this.lastError = null;
    return this.getStatus();
  }

  async getRollbackInfo() {
    if (!this.userDataDir) return { available: false };
    const metadataPath = join(this.userDataDir, 'updates', 'rollback', 'rollback-metadata.json');
    try {
      const content = await readFile(metadataPath, 'utf8');
      const data = JSON.parse(content);
      return {
        available: data.status === 'available',
        version: data.currentVersion,
        targetVersion: data.targetVersion,
        timestamp: data.timestamp,
        status: data.status,
        artifactName: data.stagedArtifactName,
      };
    } catch {
      return { available: false };
    }
  }

  async getStatus() {
    const rollbackInfo = await this.getRollbackInfo();
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
      mechanism: this.isPackaged ? 'staged-ready' : 'staged-development',
      supported: Boolean(this.userDataDir),
      updateInfo: this.updateInfo ? { ...this.updateInfo } : undefined,
      downloadProgress: this.downloadProgress ? { ...this.downloadProgress } : undefined,
      rollbackInfo,
      stagedPath: this.stagedPath,
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
    this.state = 'checking';
    this.lastError = null;

    try {
      const channel = resolveReleaseChannel(this.currentVersion, options.channel || this.channel);
      const repository = options.repository || this.repository;

      let manifestUrl = options.manifestUrl;
      if (!manifestUrl) {
        if (options.tag) {
          manifestUrl = `https://github.com/${repository}/releases/download/${options.tag}/release-manifest.json`;
        } else if (channel === 'stable') {
          manifestUrl = `https://github.com/${repository}/releases/latest/download/release-manifest.json`;
        } else {
          manifestUrl = `https://github.com/${repository}/releases/latest/download/release-manifest.json`;
        }
      }

      if (!validateCanonicalReleaseUrl(manifestUrl, repository)) {
        throw new Error(`Untrusted release metadata URL: ${manifestUrl}`);
      }

      const response = await this.fetch(manifestUrl, {
        headers: { 'User-Agent': `Quizzer-Desktop-Updater/${this.currentVersion}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch release metadata: HTTP ${response.status}`);
      }

      const manifestText = await response.text();
      const verifiedManifest = await this.verifyManifest(manifestText);

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
    if (this.state !== 'available' || !this.updateInfo) {
      throw new Error('No update is currently available to download');
    }

    this.state = 'downloading';
    this.downloadProgress = { bytesDownloaded: 0, totalBytes: this.updateInfo.artifact.size, percent: 0 };
    this.lastError = null;

    if (!this.userDataDir) {
      this.state = 'error';
      this.lastError = 'User data directory not configured';
      throw new Error(this.lastError);
    }

    const stagingDir = join(this.userDataDir, 'updates', 'staging');
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    const artifact = this.updateInfo.artifact;
    const tempPath = join(stagingDir, `download-${Date.now()}-${artifact.name}.tmp`);
    const finalPath = join(stagingDir, artifact.name);

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
          await fileHandle.write(value);
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
        await fileHandle.write(buffer);
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

      const stagedManifest = {
        version: this.updateInfo.version,
        channel: this.updateInfo.channel,
        publishedAt: this.updateInfo.publishedAt,
        publicKeyId: this.updateInfo.publicKeyId,
        artifact: this.updateInfo.artifact,
        stagedPath: finalPath,
        size: bytesReceived,
        sha256: calculatedSha256,
        stagedAt: new Date().toISOString(),
      };
      await writeFile(join(stagingDir, 'staged-update.json'), JSON.stringify(stagedManifest, null, 2), { mode: 0o600 });

      this.state = 'downloaded';
      this.stagedPath = finalPath;
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
    if (this.state !== 'downloaded' || !this.stagedPath) {
      throw new Error('No verified update is ready to apply');
    }

    this.state = 'applying';
    this.lastError = null;

    try {
      const stagingDir = join(this.userDataDir, 'updates', 'staging');
      const stagedManifestPath = join(stagingDir, 'staged-update.json');
      const stagedManifestContent = await readFile(stagedManifestPath, 'utf8');
      const stagedManifest = JSON.parse(stagedManifestContent);

      const stagedFileStat = await stat(stagedManifest.stagedPath);
      if (stagedFileStat.size !== stagedManifest.size) {
        throw new Error(`Staged artifact file size tampered: expected ${stagedManifest.size}, found ${stagedFileStat.size}`);
      }
      const actualFileBytes = await readFile(stagedManifest.stagedPath);
      const actualSha = createHash('sha256').update(actualFileBytes).digest('hex');
      if (actualSha !== stagedManifest.sha256) {
        throw new Error(`Staged artifact checksum tampered: expected ${stagedManifest.sha256}, found ${actualSha}`);
      }

      const rollbackDir = join(this.userDataDir, 'updates', 'rollback');
      await mkdir(rollbackDir, { recursive: true, mode: 0o700 });

      const rollbackMetadata = {
        status: 'available',
        currentVersion: this.currentVersion,
        targetVersion: stagedManifest.version,
        timestamp: new Date().toISOString(),
        stagedArtifactName: stagedManifest.artifact.name,
        stagedPath: stagedManifest.stagedPath,
        platform: this.platform,
        architecture: this.architecture,
      };

      await writeFile(join(rollbackDir, 'rollback-metadata.json'), JSON.stringify(rollbackMetadata, null, 2), { mode: 0o600 });

      this.state = 'applied';
      return {
        applied: true,
        restartRequested: options.restart ?? false,
        mechanism: this.isPackaged ? 'staged-ready' : 'staged-development',
        message: this.isPackaged
          ? 'Update staged for application on restart.'
          : 'Update verified and staged. In unpacked development mode, binary replacement is simulated.',
        stagedPath: this.stagedPath,
        status: await this.getStatus(),
      };
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async rollbackUpdate() {
    if (!this.userDataDir) {
      throw new Error('User data directory not configured');
    }

    const rollbackDir = join(this.userDataDir, 'updates', 'rollback');
    const metadataPath = join(rollbackDir, 'rollback-metadata.json');

    let metadata;
    try {
      const content = await readFile(metadataPath, 'utf8');
      metadata = JSON.parse(content);
    } catch {
      throw new Error('No rollback metadata available');
    }

    if (metadata.status !== 'available') {
      throw new Error(`Cannot rollback: rollback status is "${metadata.status}"`);
    }

    metadata.status = 'restored';
    metadata.restoredAt = new Date().toISOString();
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });

    this.state = 'rolled-back';
    return {
      rolledBack: true,
      restoredVersion: metadata.currentVersion,
      status: await this.getStatus(),
    };
  }
}
