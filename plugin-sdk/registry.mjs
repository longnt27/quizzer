import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";
import { PLUGIN_CAPABILITIES } from "./manifest.mjs";

export const CATALOG_SCHEMA_VERSION = 1;
export const CANONICAL_REPOSITORY = "Somethings1/quizzer";
export const MAX_CATALOG_SIZE = 1 * 1024 * 1024; // 1 MiB
export const MAX_MANIFEST_SIZE = 512 * 1024; // 512 KiB
export const MAX_INDIVIDUAL_FILE_SIZE = 64 * 1024 * 1024; // 64 MiB
export const MAX_TOTAL_PLUGIN_SIZE = 256 * 1024 * 1024; // 256 MiB
export const LARGE_DOWNLOAD_THRESHOLD = 25 * 1024 * 1024; // 25 MiB
export const DEFAULT_PLUGIN_REGISTRY_URL = "https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json";

const supportedOperatingSystems = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["x64", "arm64"]);
const supportedFilesystemPermissions = new Set(["scoped-temp", "document-read", "model-read", "persistent-data"]);
const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const pluginIdRegex = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const secretNameRegex = /^[A-Z][A-Z0-9_]{1,63}$/;
const sha256Regex = /^[a-f0-9]{64}$/;

export const parseSemver = version => {
  if (typeof version !== "string") return null;
  const match = semverRegex.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
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

    if (num1 !== null && num2 !== null) return num1 > num2 ? 1 : -1;
    if (num1 !== null && num2 === null) return -1;
    if (num1 === null && num2 !== null) return 1;
    return id1.localeCompare(id2);
  }
  return 0;
};

export const canonicalize = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const catalogSignaturePayload = catalog => {
  const unsigned = { ...catalog };
  delete unsigned.signature;
  return Buffer.from(canonicalize(unsigned));
};

export const normalizePublicKey = value => {
  if (!value) return null;
  if (value instanceof KeyObject) {
    if (value.type !== "public") throw new Error("KeyObject must be of type public");
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("-----BEGIN")) {
      return createPublicKey(trimmed);
    }
    try {
      return createPublicKey({
        key: Buffer.from(trimmed, "base64"),
        format: "der",
        type: "spki",
      });
    } catch {
      return createPublicKey(trimmed);
    }
  }
  if (typeof value === "object" && value.kty === "OKP" && value.crv === "Ed25519") {
    return createPublicKey({ key: value, format: "jwk" });
  }
  throw new Error("Unsupported public key format");
};

export const validateCanonicalPluginReleaseUrl = (urlValue, repository = CANONICAL_REPOSITORY) => {
  if (typeof urlValue !== "string") return false;
  if (urlValue.includes("..") || urlValue.includes("\\") || /%2[ee]/i.test(urlValue)) return false;
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.hostname !== "github.com") return false;
    const prefix = `/${repository}/releases/download/`;
    const latestPrefix = `/${repository}/releases/latest/download/`;
    if (!url.pathname.startsWith(prefix) && !url.pathname.startsWith(latestPrefix)) return false;
    if (url.pathname.includes("..") || url.pathname.includes("\\")) return false;
    return true;
  } catch {
    return false;
  }
};

const requireObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};

const requireString = (value, label, maximum = 500) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must be a non-empty string`);
  return value;
};

export const validateRegistryCatalog = catalog => {
  const obj = requireObject(catalog, "Registry catalog");
  if (obj.schemaVersion !== CATALOG_SCHEMA_VERSION) throw new Error(`Unsupported registry catalog schema version: ${obj.schemaVersion}`);
  if (!obj.version || (typeof obj.version !== "string" && typeof obj.version !== "number")) throw new Error("Registry catalog version must be a string or number");
  requireString(obj.publishedAt, "Registry catalog publishedAt");
  if (Number.isNaN(Date.parse(obj.publishedAt))) throw new Error("Registry catalog publishedAt must be a valid ISO date");
  if (obj.signatureAlgorithm !== "ed25519") throw new Error(`Unsupported signature algorithm: ${obj.signatureAlgorithm}. Only ed25519 is accepted.`);
  requireString(obj.publicKeyId, "Registry catalog publicKeyId", 100);
  requireString(obj.signature, "Registry catalog signature", 2000);
  if (!Array.isArray(obj.plugins)) throw new Error("Registry catalog plugins must be an array");

  const seenIds = new Set();
  for (const entry of obj.plugins) {
    requireObject(entry, "Registry plugin entry");
    if (!pluginIdRegex.test(entry.id ?? "")) throw new Error(`Invalid plugin id in registry entry: ${entry.id}`);
    if (seenIds.has(entry.id)) throw new Error(`Duplicate plugin id in registry catalog: ${entry.id}`);
    seenIds.add(entry.id);

    requireString(entry.name, `Registry entry ${entry.id} name`, 100);
    if (!semverRegex.test(entry.version ?? "")) throw new Error(`Registry entry ${entry.id} version must use semantic versioning`);
    if (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > 500)) {
      throw new Error(`Registry entry ${entry.id} description is invalid`);
    }

    if (!Array.isArray(entry.capabilities) || !entry.capabilities.length
      || entry.capabilities.some(c => !PLUGIN_CAPABILITIES.includes(c))
      || new Set(entry.capabilities).size !== entry.capabilities.length) {
      throw new Error(`Registry entry ${entry.id} capabilities are invalid`);
    }

    if (!Array.isArray(entry.platforms) || !entry.platforms.length) {
      throw new Error(`Registry entry ${entry.id} platforms are required`);
    }
    for (const platform of entry.platforms) {
      requireObject(platform, `Registry entry ${entry.id} platform`);
      if (!supportedOperatingSystems.has(platform.os)) {
        throw new Error(`Unsupported registry plugin operating system: ${platform.os}`);
      }
      if (!Array.isArray(platform.architectures) || !platform.architectures.length
        || platform.architectures.some(a => !supportedArchitectures.has(a))) {
        throw new Error(`Registry entry ${entry.id} architectures are invalid`);
      }
    }

    const resources = requireObject(entry.resources, `Registry entry ${entry.id} resources`);
    for (const key of ["memoryMB", "diskMB"]) {
      if (!Number.isSafeInteger(resources[key]) || resources[key] < 0) {
        throw new Error(`Registry entry ${entry.id} ${key} must be a non-negative integer`);
      }
    }

    const permissions = requireObject(entry.permissions, `Registry entry ${entry.id} permissions`);
    if (!Array.isArray(permissions.network) || permissions.network.some(item => typeof item !== "string" || !item)) {
      throw new Error(`Registry entry ${entry.id} network permissions are invalid`);
    }
    if (!Array.isArray(permissions.filesystem) || permissions.filesystem.some(item => !supportedFilesystemPermissions.has(item))) {
      throw new Error(`Registry entry ${entry.id} filesystem permissions are invalid`);
    }
    if (!Array.isArray(permissions.secrets) || permissions.secrets.some(item => !secretNameRegex.test(item))) {
      throw new Error(`Registry entry ${entry.id} secret permissions are invalid`);
    }
    if (typeof permissions.subprocess !== "boolean") {
      throw new Error(`Registry entry ${entry.id} subprocess permission must be a boolean`);
    }

    requireString(entry.manifestUrl, `Registry entry ${entry.id} manifestUrl`, 2000);
    if (!validateCanonicalPluginReleaseUrl(entry.manifestUrl)) {
      throw new Error(`Registry entry ${entry.id} manifestUrl must be a canonical credential-free HTTPS Quizzer GitHub Release URL`);
    }
    if (entry.downloadBaseUrl && !validateCanonicalPluginReleaseUrl(entry.downloadBaseUrl)) {
      throw new Error(`Registry entry ${entry.id} downloadBaseUrl must be a canonical credential-free HTTPS Quizzer GitHub Release URL`);
    }
    if (entry.files) {
      if (!Array.isArray(entry.files)) throw new Error(`Registry entry ${entry.id} files must be an array`);
      for (const file of entry.files) {
        requireObject(file, `Registry entry ${entry.id} file`);
        requireString(file.path, "File path");
        if (file.url && !validateCanonicalPluginReleaseUrl(file.url)) {
          throw new Error(`Registry entry ${entry.id} file ${file.path} url must be a canonical credential-free HTTPS Quizzer GitHub Release URL`);
        }
        if (file.sha256 && !sha256Regex.test(file.sha256)) {
          throw new Error(`Registry entry ${entry.id} file ${file.path} sha256 is invalid`);
        }
      }
    }
  }
  return obj;
};

export const signRegistryCatalog = (catalog, privateKeyInput) => {
  const unsigned = { ...catalog };
  delete unsigned.signature;
  const privateKey = typeof privateKeyInput === "string"
    ? (privateKeyInput.trim().startsWith("-----BEGIN")
        ? createPrivateKey(privateKeyInput)
        : createPrivateKey({ key: Buffer.from(privateKeyInput.trim(), "base64"), format: "der", type: "pkcs8" }))
    : privateKeyInput;

  const payload = catalogSignaturePayload(unsigned);
  const signature = sign(null, payload, privateKey).toString("base64url");
  const signed = { ...unsigned, signature };
  validateRegistryCatalog(signed);
  return signed;
};

export const verifyRegistryCatalogSignature = (catalog, trustedRegistryKeys) => {
  if (!catalog || typeof catalog !== "object") throw new Error("Registry catalog must be an object");
  if (catalog.signatureAlgorithm !== "ed25519") throw new Error(`Unsupported signature algorithm: ${catalog.signatureAlgorithm}. Only ed25519 is accepted.`);
  if (!catalog.publicKeyId) throw new Error("Registry catalog is missing publicKeyId");
  if (!catalog.signature || typeof catalog.signature !== "string") throw new Error("Registry catalog is missing signature");

  const rawKey = trustedRegistryKeys?.[catalog.publicKeyId];
  if (!rawKey) throw new Error(`Plugin registry signing key is not trusted: ${catalog.publicKeyId}`);
  const publicKey = normalizePublicKey(rawKey);

  const payload = catalogSignaturePayload(catalog);
  const sigBuffer = Buffer.from(
    catalog.signature,
    catalog.signature.includes("-") || catalog.signature.includes("_") ? "base64url" : "base64",
  );
  const valid = verify(null, payload, publicKey, sigBuffer);
  if (!valid) throw new Error("Plugin registry catalog signature verification failed");

  validateRegistryCatalog(catalog);
  return true;
};

export const fetchBoundedBuffer = async (fetchFn, url, options = {}, maxBytes = MAX_CATALOG_SIZE) => {
  if (!validateCanonicalPluginReleaseUrl(url)) {
    throw new Error(`Untrusted plugin download URL: ${url}. Must be a canonical credential-free HTTPS Quizzer GitHub Release URL.`);
  }

  const response = await fetchFn(url, {
    ...options,
    redirect: "error",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Redirects are disabled for plugin downloads from ${url}: HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch from ${url}: HTTP ${response.status}`);
  }

  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Response from ${url} exceeded maximum allowable size (${contentLength} > ${maxBytes})`);
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new Error(`Response from ${url} exceeded maximum allowable size of ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Response from ${url} exceeded maximum allowable size of ${maxBytes} bytes`);
    }
    return buffer;
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length > maxBytes) {
      throw new Error(`Response from ${url} exceeded maximum allowable size of ${maxBytes} bytes`);
    }
    return buffer;
  }

  throw new Error("Unsupported response body format");
};

export const fetchBoundedText = async (fetchFn, url, options = {}, maxBytes = MAX_CATALOG_SIZE) => {
  const buffer = await fetchBoundedBuffer(fetchFn, url, options, maxBytes);
  return buffer.toString("utf8");
};

export const checkPluginSecurityConfirmations = (newPluginOrManifest, previousManifest = null, downloadBytes = 0) => {
  const permissions = newPluginOrManifest.permissions || {};
  const previousPermissions = previousManifest?.permissions || {};
  const reasons = [];

  const currentNetwork = permissions.network || [];
  const prevNetwork = new Set(previousPermissions.network || []);
  const newNetwork = currentNetwork.filter(h => !prevNetwork.has(h));
  if (newNetwork.length > 0) {
    reasons.push(previousManifest ? `New network access: ${newNetwork.join(", ")}` : `Network access: ${newNetwork.join(", ")}`);
  }

  const currentSecrets = permissions.secrets || [];
  const prevSecrets = new Set(previousPermissions.secrets || []);
  const newSecrets = currentSecrets.filter(s => !prevSecrets.has(s));
  if (newSecrets.length > 0) {
    reasons.push(previousManifest ? `New secret access: ${newSecrets.join(", ")}` : `Secret access: ${newSecrets.join(", ")}`);
  }

  if (permissions.subprocess && (!previousManifest || !previousPermissions.subprocess)) {
    reasons.push("Subprocess execution permission");
  }

  const elevatedFs = ["persistent-data", "document-read", "model-read"];
  const currentFs = permissions.filesystem || [];
  const prevFs = new Set(previousPermissions.filesystem || []);
  const newElevatedFs = currentFs.filter(fs => elevatedFs.includes(fs) && !prevFs.has(fs));
  if (newElevatedFs.length > 0) {
    reasons.push(previousManifest ? `New filesystem access: ${newElevatedFs.join(", ")}` : `Filesystem access: ${newElevatedFs.join(", ")}`);
  }

  if (downloadBytes >= LARGE_DOWNLOAD_THRESHOLD) {
    const sizeMb = (downloadBytes / (1024 * 1024)).toFixed(1);
    reasons.push(`Large download size: ${sizeMb} MB`);
  }

  return {
    requiresConfirmation: reasons.length > 0,
    reasons,
    details: {
      newNetwork,
      newSecrets,
      subprocess: Boolean(permissions.subprocess && (!previousManifest || !previousPermissions.subprocess)),
      newElevatedFs,
      largeDownload: downloadBytes >= LARGE_DOWNLOAD_THRESHOLD,
      downloadBytes,
    },
  };
};
