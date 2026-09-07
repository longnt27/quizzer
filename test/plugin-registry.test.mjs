import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  CATALOG_SCHEMA_VERSION,
  DEFAULT_PLUGIN_REGISTRY_URL,
  MAX_CATALOG_SIZE,
  MAX_INDIVIDUAL_FILE_SIZE,
  MAX_MANIFEST_SIZE,
  MAX_TOTAL_PLUGIN_SIZE,
  LARGE_DOWNLOAD_THRESHOLD,
  checkPluginSecurityConfirmations,
  compareSemver,
  fetchBoundedBuffer,
  fetchBoundedText,
  parseSemver,
  signRegistryCatalog,
  validateCanonicalPluginReleaseUrl,
  validateRegistryCatalog,
  verifyRegistryCatalogSignature,
} from "../plugin-sdk/registry.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = "quizzer-registry-2026";
const trustedKeys = {
  [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
};

const createSampleCatalog = () => ({
  schemaVersion: CATALOG_SCHEMA_VERSION,
  version: "2026.09.01",
  publishedAt: "2026-09-01T00:00:00.000Z",
  signatureAlgorithm: "ed25519",
  publicKeyId: keyId,
  plugins: [
    {
      id: "fast-embedder",
      name: "Fast Local Embedder",
      version: "1.2.0",
      description: "Accelerated local embeddings",
      capabilities: ["embedder"],
      platforms: [
        { os: "darwin", architectures: ["arm64", "x64"] },
        { os: "linux", architectures: ["x64"] },
      ],
      resources: { memoryMB: 512, diskMB: 200 },
      permissions: {
        network: [],
        filesystem: ["scoped-temp"],
        secrets: [],
        subprocess: false,
      },
      manifestUrl: "https://github.com/Somethings1/quizzer/releases/download/plugins/fast-embedder-1.2.0.manifest.json",
      downloadBaseUrl: "https://github.com/Somethings1/quizzer/releases/download/plugins/",
      downloadSize: 15 * 1024 * 1024,
    },
  ],
});

test("canonical GitHub release URL validator strictly enforces repository and credentials rules", () => {
  assert.equal(validateCanonicalPluginReleaseUrl("https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json"), true);
  assert.equal(validateCanonicalPluginReleaseUrl("https://github.com/Somethings1/quizzer/releases/latest/download/catalog.json"), true);

  // Non-HTTPS
  assert.equal(validateCanonicalPluginReleaseUrl("http://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json"), false);
  // Credentials in URL
  assert.equal(validateCanonicalPluginReleaseUrl("https://user:pass@github.com/Somethings1/quizzer/releases/download/plugins/catalog.json"), false);
  // Non-GitHub hosts
  assert.equal(validateCanonicalPluginReleaseUrl("https://evil.com/Somethings1/quizzer/releases/download/plugins/catalog.json"), false);
  assert.equal(validateCanonicalPluginReleaseUrl("https://raw.githubusercontent.com/Somethings1/quizzer/main/catalog.json"), false);
  // Wrong repository
  assert.equal(validateCanonicalPluginReleaseUrl("https://github.com/attacker/quizzer/releases/download/plugins/catalog.json"), false);
  // Path traversal attempts
  assert.equal(validateCanonicalPluginReleaseUrl("https://github.com/Somethings1/quizzer/releases/download/plugins/../../escape.json"), false);
  assert.equal(validateCanonicalPluginReleaseUrl("https://github.com/Somethings1/quizzer/releases/download/plugins/..\\escape.json"), false);
  // Malformed URL
  assert.equal(validateCanonicalPluginReleaseUrl("not-a-url"), false);
});

test("validates and signs registry catalog, verifying Ed25519 signature correctly", () => {
  const catalog = createSampleCatalog();
  const signed = signRegistryCatalog(catalog, privateKey);
  assert.ok(signed.signature);

  // Verifies with trusted keys
  assert.equal(verifyRegistryCatalogSignature(signed, trustedKeys), true);

  // Rejects untrusted key id
  assert.throws(
    () => verifyRegistryCatalogSignature(signed, { "other-key": trustedKeys[keyId] }),
    /signing key is not trusted/
  );

  // Rejects tampered catalog
  const tampered = { ...signed, plugins: [{ ...signed.plugins[0], version: "2.0.0" }] };
  assert.throws(
    () => verifyRegistryCatalogSignature(tampered, trustedKeys),
    /signature verification failed/
  );

  // Rejects invalid signature algorithms
  const invalidAlg = { ...signed, signatureAlgorithm: "rsa" };
  assert.throws(
    () => verifyRegistryCatalogSignature(invalidAlg, trustedKeys),
    /Unsupported signature algorithm/
  );
});

test("validates catalog contract constraints and rejects malformed fields", () => {
  const base = createSampleCatalog();

  assert.throws(() => validateRegistryCatalog(null), /must be an object/);
  assert.throws(() => validateRegistryCatalog({ ...base, schemaVersion: 2 }), /Unsupported registry catalog schema version/);
  assert.throws(() => validateRegistryCatalog({ ...base, publishedAt: "invalid-date" }), /must be a valid ISO date/);
  assert.throws(() => validateRegistryCatalog({ ...base, signature: "" }), /signature must be a non-empty string/);

  // Duplicate plugin ID
  const dup = {
    ...base,
    signature: "sig",
    plugins: [base.plugins[0], { ...base.plugins[0] }],
  };
  assert.throws(() => validateRegistryCatalog(dup), /Duplicate plugin id/);

  // Invalid plugin ID format
  const invalidId = {
    ...base,
    signature: "sig",
    plugins: [{ ...base.plugins[0], id: "Invalid_ID!" }],
  };
  assert.throws(() => validateRegistryCatalog(invalidId), /Invalid plugin id/);

  // Invalid semver
  const invalidVer = {
    ...base,
    signature: "sig",
    plugins: [{ ...base.plugins[0], version: "1.0" }],
  };
  assert.throws(() => validateRegistryCatalog(invalidVer), /semantic versioning/);

  // Untrusted manifest URL
  const invalidUrl = {
    ...base,
    signature: "sig",
    plugins: [{ ...base.plugins[0], manifestUrl: "https://evil.com/manifest.json" }],
  };
  assert.throws(() => validateRegistryCatalog(invalidUrl), /canonical credential-free HTTPS Quizzer GitHub Release URL/);

  // Unsupported platform OS
  const invalidPlatform = {
    ...base,
    signature: "sig",
    plugins: [{ ...base.plugins[0], platforms: [{ os: "freebsd", architectures: ["x64"] }] }],
  };
  assert.throws(() => validateRegistryCatalog(invalidPlatform), /Unsupported registry plugin operating system/);
});

test("fetchBoundedBuffer enforces canonical URLs, redirect rejection, and size boundaries", async () => {
  // Reject non-canonical URL
  await assert.rejects(
    () => fetchBoundedBuffer(async () => {}, "https://evil.com/catalog.json"),
    /Untrusted plugin download URL/
  );

  // Redirect rejection (HTTP 301/302)
  const redirectFetch = async () => ({
    status: 302,
    ok: false,
    headers: new Map(),
  });
  await assert.rejects(
    () => fetchBoundedBuffer(redirectFetch, "https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json"),
    /Redirects are disabled/
  );

  // HTTP error
  const notFoundFetch = async () => ({
    status: 404,
    ok: false,
    headers: new Map(),
  });
  await assert.rejects(
    () => fetchBoundedBuffer(notFoundFetch, "https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json"),
    /HTTP 404/
  );

  // Exceeding Content-Length
  const largeHeaderFetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: (hn) => (hn === "content-length" ? "2000" : null) },
    arrayBuffer: async () => new ArrayBuffer(2000),
  });
  await assert.rejects(
    () => fetchBoundedBuffer(largeHeaderFetch, "https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json", {}, 1000),
    /exceeded maximum allowable size/
  );

  // Exceeding streamed bytes
  const largeStreamFetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: new Uint8Array(2000) };
          },
        };
      },
    },
  });
  await assert.rejects(
    () => fetchBoundedBuffer(largeStreamFetch, "https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json", {}, 1000),
    /exceeded maximum allowable size of 1000 bytes/
  );

  // Successful bounded read
  const validFetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: (hn) => (hn === "content-length" ? "5" : null) },
    arrayBuffer: async () => Buffer.from("hello"),
  });
  const text = await fetchBoundedText(validFetch, "https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json", {}, 1000);
  assert.equal(text, "hello");
});

test("compareSemver correctly ranks semantic versions and prereleases", () => {
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
  assert.equal(compareSemver("1.0.1", "1.1.0"), -1);
  assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0-beta.1"), 1);
  assert.throws(() => compareSemver("not-semver", "1.0.0"), /Invalid semver comparison/);
});

test("checkPluginSecurityConfirmations detects network, secrets, subprocess, elevated fs, and large download size", () => {
  const benignPlugin = {
    permissions: {
      network: [],
      secrets: [],
      subprocess: false,
      filesystem: ["scoped-temp"],
    },
  };
  const benignCheck = checkPluginSecurityConfirmations(benignPlugin, null, 10 * 1024 * 1024);
  assert.equal(benignCheck.requiresConfirmation, false);
  assert.equal(benignCheck.reasons.length, 0);

  // Network permission requires confirmation
  const netPlugin = {
    permissions: {
      network: ["https://api.example.com"],
      secrets: [],
      subprocess: false,
      filesystem: ["scoped-temp"],
    },
  };
  const netCheck = checkPluginSecurityConfirmations(netPlugin, null, 1000);
  assert.equal(netCheck.requiresConfirmation, true);
  assert.match(netCheck.reasons[0], /Network access: https:\/\/api\.example\.com/);

  // Subprocess permission requires confirmation
  const subPlugin = {
    permissions: {
      network: [],
      secrets: [],
      subprocess: true,
      filesystem: ["scoped-temp"],
    },
  };
  const subCheck = checkPluginSecurityConfirmations(subPlugin, null, 1000);
  assert.equal(subCheck.requiresConfirmation, true);
  assert.match(subCheck.reasons[0], /Subprocess execution permission/);

  // Elevated filesystem permissions
  for (const fsPerm of ["persistent-data", "document-read", "model-read"]) {
    const fsPlugin = {
      permissions: {
        network: [],
        secrets: [],
        subprocess: false,
        filesystem: ["scoped-temp", fsPerm],
      },
    };
    const fsCheck = checkPluginSecurityConfirmations(fsPlugin, null, 1000);
    assert.equal(fsCheck.requiresConfirmation, true);
    assert.match(fsCheck.reasons[0], new RegExp("Filesystem access: " + fsPerm));
  }

  // Large download size (>= 25 MiB)
  const largeCheck = checkPluginSecurityConfirmations(benignPlugin, null, 25 * 1024 * 1024);
  assert.equal(largeCheck.requiresConfirmation, true);
  assert.match(largeCheck.reasons[0], /Large download size: 25\.0 MB/);

  // Diff comparison: no new permissions when updating identical permissions
  const prevPlugin = {
    permissions: {
      network: ["https://api.example.com"],
      secrets: ["API_TOKEN"],
      subprocess: true,
      filesystem: ["scoped-temp", "persistent-data"],
    },
  };
  const sameCheck = checkPluginSecurityConfirmations(prevPlugin, prevPlugin, 1000);
  assert.equal(sameCheck.requiresConfirmation, false);

  // Diff comparison: adding a new secret requires confirmation
  const addedSecret = {
    permissions: {
      ...prevPlugin.permissions,
      secrets: ["API_TOKEN", "NEW_TOKEN"],
    },
  };
  const secretCheck = checkPluginSecurityConfirmations(addedSecret, prevPlugin, 1000);
  assert.equal(secretCheck.requiresConfirmation, true);
  assert.match(secretCheck.reasons[0], /New secret access: NEW_TOKEN/);
});
