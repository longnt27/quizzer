import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";
import { PLUGIN_CAPABILITIES, validatePluginPath } from "./manifest.mjs";

export const CATALOG_SCHEMA_VERSION = 1;
export const CANONICAL_REPOSITORY = "longnt27/quizzer";
export const MAX_CATALOG_SIZE = 1 * 1024 * 1024; // 1 MiB
export const MAX_MANIFEST_SIZE = 512 * 1024; // 512 KiB
export const MAX_INDIVIDUAL_FILE_SIZE = 64 * 1024 * 1024; // 64 MiB
export const MAX_TOTAL_PLUGIN_SIZE = 256 * 1024 * 1024; // 256 MiB
export const LARGE_DOWNLOAD_THRESHOLD = 25 * 1024 * 1024; // 25 MiB
export const DEFAULT_PLUGIN_REGISTRY_URL = "https://github.com/longnt27/quizzer/releases/download/plugins-v1/catalog.json";

const supportedOperatingSystems = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["x64", "arm64"]);
const supportedFilesystemPermissions = new Set(["scoped-temp", "document-read", "model-read", "persistent-data"]);
const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const pluginIdRegex = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const secretNameRegex = /^[A-Z][A-Z0-9_]{1,63}$/;
const sha256Regex = /^[a-f0-9]{64}$/;
const releaseSegmentRegex = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/;
const releaseTagRegex = /^(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const registrySignatureRegex = /^[A-Za-z0-9_-]{86}$/;
const catalogKeys = new Set([
  "schemaVersion", "version", "publishedAt", "signatureAlgorithm", "publicKeyId", "signature", "plugins",
]);
const pluginKeys = new Set([
  "id", "name", "description", "version", "capabilities", "platforms", "resources", "permissions",
  "manifestUrl", "downloadBaseUrl", "downloadSize", "files",
]);
const platformKeys = new Set(["os", "architectures"]);
const resourceKeys = new Set(["memoryMB", "diskMB", "accelerators"]);
const permissionKeys = new Set(["network", "filesystem", "secrets", "subprocess"]);
const fileKeys = new Set(["path", "url", "sha256", "size"]);

export const parseSemver = version => {
  if (typeof version !== "string") return null;
  const match = semverRegex.exec(version.trim());
  if (!match) return null;
  const numericParts = match.slice(1, 4).map(Number);
  if (numericParts.some(part => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4] ? match[4].split(".") : null;
  if (prerelease?.some(part => (/^\d+$/.test(part) && (part.length > 1 && part.startsWith("0")))
    || (/^\d+$/.test(part) && !Number.isSafeInteger(Number(part))))) return null;
  return {
    major: numericParts[0],
    minor: numericParts[1],
    patch: numericParts[2],
    prerelease,
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
    if (value.asymmetricKeyType !== "ed25519") throw new Error("Registry public key must use Ed25519");
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("-----BEGIN")) {
      const key = createPublicKey(trimmed);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Registry public key must use Ed25519");
      return key;
    }
    try {
      const key = createPublicKey({
        key: Buffer.from(trimmed, "base64"),
        format: "der",
        type: "spki",
      });
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Registry public key must use Ed25519");
      return key;
    } catch {
      const key = createPublicKey(trimmed);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Registry public key must use Ed25519");
      return key;
    }
  }
  if (typeof value === "object" && value.kty === "OKP" && value.crv === "Ed25519") {
    const key = createPublicKey({ key: value, format: "jwk" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Registry public key must use Ed25519");
    return key;
  }
  throw new Error("Unsupported public key format");
};

const hasUnsafeReleasePath = value => /[\r\n\t\0\\]/.test(value) || /%2[ef]|%5c/i.test(value);

const canonicalReleaseUrl = (urlValue, repository, { base = false } = {}) => {
  if (typeof urlValue !== "string") return false;
  if (hasUnsafeReleasePath(urlValue) || urlValue.includes("?") || urlValue.includes("#")) return false;
  if (base !== urlValue.endsWith("/")) return false;
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.hostname !== "github.com") return false;
    if (url.port) return false;
    if (url.search || url.hash) return false;
    const prefix = `/${repository}/releases/download/`;
    if (!url.pathname.startsWith(prefix)) return false;
    const subpath = url.pathname.slice(prefix.length);
    const parts = subpath.split("/");
    if (base) parts.pop();
    if (parts.length !== (base ? 1 : 2)) return false;
    if (!releaseTagRegex.test(parts[0]) || parts[0].toLowerCase() === "latest") return false;
    return base || releaseSegmentRegex.test(parts[1]);
  } catch {
    return false;
  }
};

export const validateCanonicalPluginReleaseUrl = (urlValue, repository = CANONICAL_REPOSITORY) =>
  canonicalReleaseUrl(urlValue, repository);

export const validateCanonicalPluginDownloadBaseUrl = (urlValue, repository = CANONICAL_REPOSITORY) => {
  return canonicalReleaseUrl(urlValue, repository, { base: true });
};

export const validateRedirectTargetUrl = (targetUrlValue) => {
  if (typeof targetUrlValue !== "string") return false;
  try {
    const url = new URL(targetUrlValue);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.hostname !== "release-assets.githubusercontent.com") return false;
    if (url.port || url.hash) return false;
    const rawPath = targetUrlValue.split(/[?#]/, 1)[0];
    if (hasUnsafeReleasePath(rawPath) || rawPath.includes("..")) return false;
    if (!url.pathname.startsWith("/github-production-release-asset/")) return false;
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

const rejectUnknown = (value, allowed, label) => {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
};

const hasDuplicates = values => new Set(values).size !== values.length;

export const validateRegistryCatalog = catalog => {
  const obj = requireObject(catalog, "Registry catalog");
  rejectUnknown(obj, catalogKeys, "Registry catalog");
  if (obj.schemaVersion !== CATALOG_SCHEMA_VERSION) throw new Error(`Unsupported registry catalog schema version: ${obj.schemaVersion}`);
  requireString(obj.version, "Registry catalog version", 100);
  requireString(obj.publishedAt, "Registry catalog publishedAt");
  if (Number.isNaN(Date.parse(obj.publishedAt)) || new Date(obj.publishedAt).toISOString() !== obj.publishedAt) {
    throw new Error("Registry catalog publishedAt must be a canonical ISO timestamp");
  }
  if (obj.signatureAlgorithm !== "ed25519") throw new Error(`Unsupported signature algorithm: ${obj.signatureAlgorithm}. Only ed25519 is accepted.`);
  requireString(obj.publicKeyId, "Registry catalog publicKeyId", 100);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(obj.publicKeyId)) throw new Error("Registry catalog publicKeyId is invalid");
  if (!registrySignatureRegex.test(obj.signature ?? "")) throw new Error("Registry catalog signature must be a canonical Ed25519 base64url value");
  if (!Array.isArray(obj.plugins) || obj.plugins.length > 1_000) throw new Error("Registry catalog plugins must be an array of at most 1000 entries");

  const seenIds = new Set();
  for (const entry of obj.plugins) {
    requireObject(entry, "Registry plugin entry");
    rejectUnknown(entry, pluginKeys, `Registry entry ${entry.id ?? "unknown"}`);
    if (!pluginIdRegex.test(entry.id ?? "")) throw new Error(`Invalid plugin id in registry entry: ${entry.id}`);
    if (seenIds.has(entry.id)) throw new Error(`Duplicate plugin id in registry catalog: ${entry.id}`);
    seenIds.add(entry.id);

    requireString(entry.name, `Registry entry ${entry.id} name`, 100);
    if (!parseSemver(entry.version)) throw new Error(`Registry entry ${entry.id} version must use semantic versioning`);
    if (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > 500)) {
      throw new Error(`Registry entry ${entry.id} description is invalid`);
    }

    if (!Array.isArray(entry.capabilities) || !entry.capabilities.length
      || entry.capabilities.some(c => !PLUGIN_CAPABILITIES.includes(c))
      || new Set(entry.capabilities).size !== entry.capabilities.length) {
      throw new Error(`Registry entry ${entry.id} capabilities are invalid`);
    }

    if (!Array.isArray(entry.platforms) || !entry.platforms.length || entry.platforms.length > supportedOperatingSystems.size) {
      throw new Error(`Registry entry ${entry.id} platforms are required`);
    }
    const seenOperatingSystems = new Set();
    for (const platform of entry.platforms) {
      requireObject(platform, `Registry entry ${entry.id} platform`);
      rejectUnknown(platform, platformKeys, `Registry entry ${entry.id} platform`);
      if (!supportedOperatingSystems.has(platform.os)) {
        throw new Error(`Unsupported registry plugin operating system: ${platform.os}`);
      }
      if (seenOperatingSystems.has(platform.os)) throw new Error(`Registry entry ${entry.id} has duplicate platform ${platform.os}`);
      seenOperatingSystems.add(platform.os);
      if (!Array.isArray(platform.architectures) || !platform.architectures.length
        || platform.architectures.some(a => !supportedArchitectures.has(a)) || hasDuplicates(platform.architectures)) {
        throw new Error(`Registry entry ${entry.id} architectures are invalid`);
      }
    }

    const resources = requireObject(entry.resources, `Registry entry ${entry.id} resources`);
    rejectUnknown(resources, resourceKeys, `Registry entry ${entry.id} resources`);
    for (const key of ["memoryMB", "diskMB"]) {
      if (!Number.isSafeInteger(resources[key]) || resources[key] < 0 || resources[key] > 1_048_576) {
        throw new Error(`Registry entry ${entry.id} ${key} must be a non-negative integer`);
      }
    }
    if (resources.accelerators !== undefined && (!Array.isArray(resources.accelerators)
      || resources.accelerators.some(item => !["cpu", "metal", "cuda", "rocm"].includes(item))
      || hasDuplicates(resources.accelerators))) throw new Error(`Registry entry ${entry.id} accelerators are invalid`);

    const permissions = requireObject(entry.permissions, `Registry entry ${entry.id} permissions`);
    rejectUnknown(permissions, permissionKeys, `Registry entry ${entry.id} permissions`);
    if (!Array.isArray(permissions.network) || permissions.network.length > 100
      || permissions.network.some(item => typeof item !== "string" || !item.trim() || item.length > 2_000 || /[\r\n\0]/.test(item))
      || hasDuplicates(permissions.network)) {
      throw new Error(`Registry entry ${entry.id} network permissions are invalid`);
    }
    if (!Array.isArray(permissions.filesystem) || permissions.filesystem.some(item => !supportedFilesystemPermissions.has(item))
      || hasDuplicates(permissions.filesystem)) {
      throw new Error(`Registry entry ${entry.id} filesystem permissions are invalid`);
    }
    if (!Array.isArray(permissions.secrets) || permissions.secrets.length > 100
      || permissions.secrets.some(item => !secretNameRegex.test(item)) || hasDuplicates(permissions.secrets)) {
      throw new Error(`Registry entry ${entry.id} secret permissions are invalid`);
    }
    if (typeof permissions.subprocess !== "boolean") {
      throw new Error(`Registry entry ${entry.id} subprocess permission must be a boolean`);
    }

    requireString(entry.manifestUrl, `Registry entry ${entry.id} manifestUrl`, 2000);
    if (!validateCanonicalPluginReleaseUrl(entry.manifestUrl)) {
      throw new Error(`Registry entry ${entry.id} manifestUrl must be a canonical versioned credential-free HTTPS Quizzer GitHub Release URL`);
    }
    if (entry.downloadBaseUrl !== undefined && !validateCanonicalPluginDownloadBaseUrl(entry.downloadBaseUrl)) {
      throw new Error(`Registry entry ${entry.id} downloadBaseUrl must be a canonical versioned credential-free HTTPS Quizzer GitHub Release URL ending with /`);
    }
    if (typeof entry.downloadSize !== "number" || !Number.isSafeInteger(entry.downloadSize) || entry.downloadSize < 0 || entry.downloadSize > MAX_TOTAL_PLUGIN_SIZE) {
      throw new Error(`Registry entry ${entry.id} downloadSize must be a safe integer between 0 and ${MAX_TOTAL_PLUGIN_SIZE}`);
    }
    if (!Array.isArray(entry.files) || !entry.files.length || entry.files.length > 10_000) {
      throw new Error(`Registry entry ${entry.id} files must contain 1-10000 signed file records`);
    }
    const seenFilePaths = new Set();
    let declaredTotal = 0;
    for (const file of entry.files) {
      requireObject(file, `Registry entry ${entry.id} file`);
      rejectUnknown(file, fileKeys, `Registry entry ${entry.id} file`);
      requireString(file.path, "File path");
      validatePluginPath(file.path);
      if (seenFilePaths.has(file.path)) {
        throw new Error(`Duplicate file path in catalog entry ${entry.id}: ${file.path}`);
      }
      seenFilePaths.add(file.path);
      if (!validateCanonicalPluginReleaseUrl(file.url)) {
        throw new Error(`Registry entry ${entry.id} file ${file.path} url must be a canonical versioned credential-free HTTPS Quizzer GitHub Release URL`);
      }
      if (!sha256Regex.test(file.sha256 ?? "")) {
        throw new Error(`Registry entry ${entry.id} file ${file.path} sha256 is invalid`);
      }
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_INDIVIDUAL_FILE_SIZE) {
        throw new Error(`Registry entry ${entry.id} file ${file.path} size must be a safe integer between 0 and ${MAX_INDIVIDUAL_FILE_SIZE}`);
      }
      declaredTotal += file.size;
      if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_TOTAL_PLUGIN_SIZE) {
        throw new Error(`Registry entry ${entry.id} files exceed the total plugin size limit`);
      }
    }
    if (declaredTotal !== entry.downloadSize) {
      throw new Error(`Registry entry ${entry.id} downloadSize must equal its declared file sizes`);
    }
  }
  return obj;
};

export const signRegistryCatalog = (catalog, privateKeyInput) => {
  const unsigned = JSON.parse(JSON.stringify(catalog));
  delete unsigned.signature;
  const privateKey = typeof privateKeyInput === "string"
    ? (privateKeyInput.trim().startsWith("-----BEGIN")
        ? createPrivateKey(privateKeyInput)
        : createPrivateKey({ key: Buffer.from(privateKeyInput.trim(), "base64"), format: "der", type: "pkcs8" }))
    : privateKeyInput;
  if (!(privateKey instanceof KeyObject) || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Registry private key must be an Ed25519 private key");
  }

  validateRegistryCatalog({ ...unsigned, signature: "A".repeat(86) });
  const payload = catalogSignaturePayload(unsigned);
  const signature = sign(null, payload, privateKey).toString("base64url");
  const signed = { ...unsigned, signature };
  validateRegistryCatalog(signed);
  return signed;
};

export const verifyRegistryCatalogSignature = (catalog, trustedRegistryKeys) => {
  validateRegistryCatalog(catalog);

  const rawKey = trustedRegistryKeys?.[catalog.publicKeyId];
  if (!rawKey) throw new Error(`Plugin registry signing key is not trusted: ${catalog.publicKeyId}`);
  const publicKey = normalizePublicKey(rawKey);

  const payload = catalogSignaturePayload(catalog);
  const sigBuffer = Buffer.from(catalog.signature, "base64url");
  if (sigBuffer.length !== 64) throw new Error("Plugin registry catalog signature is invalid");
  const valid = verify(null, payload, publicKey, sigBuffer);
  if (!valid) throw new Error("Plugin registry catalog signature verification failed");

  return true;
};

const abortReason = signal => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error("Plugin download was cancelled"), { name: "AbortError" });

const withAbort = (operation, signal) => {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const contentLengthFor = (response, url, maxBytes) => {
  const raw = response.headers?.get?.("content-length") ?? response.headers?.get?.("Content-Length");
  if (raw === null || raw === undefined || raw === "") return;
  const value = String(raw).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Response from ${url} returned an invalid Content-Length`);
  }
  if (Number(value) > maxBytes) {
    throw new Error(`Response from ${url} exceeded maximum allowable size (${value} > ${maxBytes})`);
  }
};

const cancelResponse = response => {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); }
  catch { /* Ignore response disposal errors. */ }
};

const readBoundedResponse = async (response, url, maxBytes, signal) => {
  contentLengthFor(response, url, maxBytes);
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await withAbort(reader.read(), signal);
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error(`Response from ${url} returned an invalid byte stream`);
        received += value.byteLength;
        if (received > maxBytes) {
          throw new Error(`Response from ${url} exceeded maximum allowable size of ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, received);
    } catch (error) {
      try { Promise.resolve(reader.cancel(error)).catch(() => {}); }
      catch { /* Ignore reader disposal errors. */ }
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* The reader may still be cancelling. */ }
    }
  }

  if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await withAbort(response.arrayBuffer(), signal));
    if (buffer.length > maxBytes) throw new Error(`Response from ${url} exceeded maximum allowable size of ${maxBytes} bytes`);
    return buffer;
  }

  if (typeof response.text === "function") {
    const buffer = Buffer.from(await withAbort(response.text(), signal), "utf8");
    if (buffer.length > maxBytes) throw new Error(`Response from ${url} exceeded maximum allowable size of ${maxBytes} bytes`);
    return buffer;
  }

  throw new Error("Unsupported response body format");
};

export const fetchBoundedBuffer = async (fetchFn, initialUrl, options = {}, maxBytes = MAX_CATALOG_SIZE) => {
  if (typeof fetchFn !== "function") throw new Error("Plugin downloads require a fetch implementation");
  if (!validateCanonicalPluginReleaseUrl(initialUrl)) {
    throw new Error(`Untrusted plugin download URL: ${initialUrl}. Must be a canonical versioned credential-free HTTPS Quizzer GitHub Release URL.`);
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Plugin download options must be an object");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TOTAL_PLUGIN_SIZE) {
    throw new Error("Plugin download size limit is invalid");
  }

  const { signal: callerSignal, timeoutMs = 30_000, ...requestOptions } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Plugin download timeout must be from 1 to 300000 ms");
  }
  if (callerSignal?.aborted) throw abortReason(callerSignal);

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(callerSignal));
  callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(Object.assign(
    new Error(`Request to ${initialUrl} timed out after ${timeoutMs} ms`),
    { name: "TimeoutError" },
  )), timeoutMs);
  const fetchOptions = { ...requestOptions, redirect: "manual", signal: controller.signal };

  try {
    let response = await withAbort(fetchFn(initialUrl, fetchOptions), controller.signal);
    let responseUrl = initialUrl;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.("location") ?? response.headers?.get?.("Location");
      if (typeof location !== "string" || !location.trim()) {
        cancelResponse(response);
        throw new Error(`Redirect from ${initialUrl} missing Location header (HTTP ${response.status})`);
      }
      let targetUrl;
      try { targetUrl = new URL(location, initialUrl).href; }
      catch {
        cancelResponse(response);
        throw new Error("Plugin download returned an invalid redirect Location");
      }
      if (!validateRedirectTargetUrl(targetUrl)) {
        cancelResponse(response);
        throw new Error("Plugin download redirect must target credential-free release-assets.githubusercontent.com on its default HTTPS port");
      }
      cancelResponse(response);
      response = await withAbort(fetchFn(targetUrl, fetchOptions), controller.signal);
      responseUrl = targetUrl;
      if (response.status >= 300 && response.status < 400) {
        cancelResponse(response);
        throw new Error(`Second plugin download redirect is prohibited (HTTP ${response.status})`);
      }
    }
    if (!response.ok) {
      cancelResponse(response);
      throw new Error(`Failed to fetch plugin asset: HTTP ${response.status}`);
    }
    return await readBoundedResponse(response, responseUrl, maxBytes, controller.signal);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
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
