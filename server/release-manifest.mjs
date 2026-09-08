export const MAX_DESKTOP_PACKAGE_SIZE = 1024 * 1024 * 1024; // 1 GiB

export const isValidArtifactName = name => {
  if (typeof name !== 'string' || !name || name.length > 128) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return false;
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$/.test(name);
};

const platforms = new Set(['windows', 'macos', 'linux']);
const architectures = new Set(['x64', 'arm64']);
const formats = new Set(['exe', 'msi', 'dmg', 'pkg', 'zip', 'appimage', 'deb', 'rpm', 'tar.gz', 'sea']);

const trustedReleaseUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com'
      && url.pathname.startsWith('/longnt27/quizzer/releases/download/');
  } catch { return false; }
};

export const validateReleaseManifest = manifest => {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { valid: false, errors: ['Manifest must be an object'] };
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) errors.push('version must be semantic');
  if (manifest.channel !== 'stable' && manifest.channel !== 'beta') errors.push('channel must be stable or beta');
  if (!Number.isFinite(Date.parse(manifest.publishedAt ?? ''))) errors.push('publishedAt must be an ISO date');
  if (manifest.signatureAlgorithm !== 'ed25519') errors.push('signatureAlgorithm must be ed25519');
  if (typeof manifest.publicKeyId !== 'string' || !manifest.publicKeyId) errors.push('publicKeyId is missing');
  if (typeof manifest.signature !== 'string' || manifest.signature.length < 40) errors.push('signature is missing');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) errors.push('artifacts must not be empty');

  const targets = new Set();
  for (const [index, artifact] of (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).entries()) {
    const prefix = `artifacts[${index}]`;
    if (!artifact || typeof artifact !== 'object') { errors.push(`${prefix} must be an object`); continue; }
    if (!isValidArtifactName(artifact.name)) {
      errors.push(`${prefix}.name is invalid: must be a safe filename without path separators, traversal, or control characters, up to 128 characters`);
    }
    if (!platforms.has(artifact.platform)) errors.push(`${prefix}.platform is unsupported`);
    if (!architectures.has(artifact.architecture)) errors.push(`${prefix}.architecture is unsupported`);
    if (!formats.has(artifact.format)) errors.push(`${prefix}.format is unsupported`);
    if (!trustedReleaseUrl(artifact.url)) errors.push(`${prefix}.url must be a Quizzer GitHub Release URL`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_DESKTOP_PACKAGE_SIZE) {
      errors.push(`${prefix}.size must be a positive integer not exceeding ${MAX_DESKTOP_PACKAGE_SIZE} bytes`);
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) errors.push(`${prefix}.sha256 must be lowercase SHA-256`);
    if (typeof artifact.minimumOs !== 'string' || !artifact.minimumOs) errors.push(`${prefix}.minimumOs is required`);
    const target = `${artifact.platform}:${artifact.architecture}:${artifact.format}`;
    if (targets.has(target)) errors.push(`${prefix} duplicates target ${target}`);
    targets.add(target);
  }
  return { valid: errors.length === 0, errors };
};
