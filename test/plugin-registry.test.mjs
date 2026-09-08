import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  CATALOG_SCHEMA_VERSION,
  LARGE_DOWNLOAD_THRESHOLD,
  checkPluginSecurityConfirmations,
  compareSemver,
  fetchBoundedBuffer,
  fetchBoundedText,
  signRegistryCatalog,
  validateCanonicalPluginDownloadBaseUrl,
  validateCanonicalPluginReleaseUrl,
  validateRedirectTargetUrl,
  validateRegistryCatalog,
  verifyRegistryCatalogSignature,
} from "../plugin-sdk/registry.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = "quizzer-registry-2026";
const trustedKeys = {
  [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const releaseRoot = "https://github.com/longnt27/quizzer/releases/download/plugins-v1";
const assetUrl = name => `${releaseRoot}/${name}`;
const pluginSource = "process.stdin.pipe(process.stdout);\n";
const pluginHash = createHash("sha256").update(pluginSource).digest("hex");

const createSampleCatalog = (pluginOverrides = {}) => ({
  schemaVersion: CATALOG_SCHEMA_VERSION,
  version: "2026.09.01",
  publishedAt: "2026-09-01T00:00:00.000Z",
  signatureAlgorithm: "ed25519",
  publicKeyId: keyId,
  plugins: [{
    id: "fast-embedder",
    name: "Fast Local Embedder",
    version: "1.2.0",
    description: "Accelerated local embeddings",
    capabilities: ["embedder"],
    platforms: [
      { os: "darwin", architectures: ["arm64", "x64"] },
      { os: "linux", architectures: ["x64"] },
    ],
    resources: { memoryMB: 512, diskMB: 200, accelerators: ["cpu"] },
    permissions: { network: [], filesystem: ["scoped-temp"], secrets: [], subprocess: false },
    manifestUrl: assetUrl("fast-embedder-1.2.0.manifest.json"),
    downloadBaseUrl: `${releaseRoot}/`,
    downloadSize: Buffer.byteLength(pluginSource),
    files: [{
      path: "plugin.mjs",
      url: assetUrl("fast-embedder-1.2.0-plugin.mjs"),
      sha256: pluginHash,
      size: Buffer.byteLength(pluginSource),
    }],
    ...pluginOverrides,
  }],
});

const catalogForValidation = (pluginOverrides = {}, catalogOverrides = {}) => ({
  ...createSampleCatalog(pluginOverrides),
  ...catalogOverrides,
  signature: "A".repeat(86),
});

test("accepts only exact immutable Quizzer release assets and the GitHub asset redirect host", () => {
  assert.equal(validateCanonicalPluginReleaseUrl(assetUrl("catalog.json")), true);
  assert.equal(validateCanonicalPluginDownloadBaseUrl(`${releaseRoot}/`), true);
  assert.equal(validateRedirectTargetUrl(
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset?sp=r&sig=a%2Fb",
  ), true);

  for (const url of [
    "https://github.com/longnt27/quizzer/releases/latest/download/catalog.json",
    "https://github.com/longnt27/quizzer/releases/download/plugins/catalog.json",
    `${releaseRoot}/nested/catalog.json`,
    `${releaseRoot}/catalog.json?download=1`,
    `${releaseRoot}/catalog.json#fragment`,
    "https://user:pass@github.com/longnt27/quizzer/releases/download/plugins-v1/catalog.json",
    "https://github.com:444/longnt27/quizzer/releases/download/plugins-v1/catalog.json",
    "https://evil.example/longnt27/quizzer/releases/download/plugins-v1/catalog.json",
    "https://github.com/attacker/quizzer/releases/download/plugins-v1/catalog.json",
    `${releaseRoot}/nested%2Fcatalog.json`,
    `${releaseRoot}/%2e%2e`,
    "not-a-url",
  ]) assert.equal(validateCanonicalPluginReleaseUrl(url), false, url);

  assert.equal(validateCanonicalPluginDownloadBaseUrl(releaseRoot), false);
  assert.equal(validateCanonicalPluginDownloadBaseUrl(`${releaseRoot}/nested/`), false);
  for (const url of [
    "https://evil.example/github-production-release-asset/123/asset",
    "https://release-assets.githubusercontent.com:444/github-production-release-asset/123/asset",
    "https://user@release-assets.githubusercontent.com/github-production-release-asset/123/asset",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset#fragment",
    "https://release-assets.githubusercontent.com/not-a-release/123/asset",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/%2e%2e%2Fasset",
  ]) assert.equal(validateRedirectTargetUrl(url), false, url);
});

test("signs a strict canonical catalog and verifies only trusted Ed25519 signatures", () => {
  const signed = signRegistryCatalog(createSampleCatalog(), privateKey);
  assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(validateRegistryCatalog(signed), signed);
  assert.equal(verifyRegistryCatalogSignature(signed, trustedKeys), true);

  assert.throws(
    () => verifyRegistryCatalogSignature(signed, { "other-key": trustedKeys[keyId] }),
    /signing key is not trusted/,
  );
  assert.throws(
    () => verifyRegistryCatalogSignature({ ...signed, plugins: [{ ...signed.plugins[0], version: "2.0.0" }] }, trustedKeys),
    /signature verification failed/,
  );
  assert.throws(
    () => verifyRegistryCatalogSignature({ ...signed, signatureAlgorithm: "rsa" }, trustedKeys),
    /Unsupported signature algorithm/,
  );
  const { privateKey: rsaPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => signRegistryCatalog(createSampleCatalog(), rsaPrivateKey), /Ed25519 private key/);
});

test("rejects ambiguous or inconsistent signed catalog metadata", () => {
  const valid = catalogForValidation();
  assert.equal(validateRegistryCatalog(valid), valid);
  assert.throws(() => validateRegistryCatalog(null), /must be an object/);
  assert.throws(() => validateRegistryCatalog({ ...valid, unknown: true }), /unsupported fields/);
  assert.throws(() => validateRegistryCatalog({ ...valid, schemaVersion: 2 }), /Unsupported registry catalog schema/);
  assert.throws(() => validateRegistryCatalog({ ...valid, publishedAt: "2026-09-01" }), /canonical ISO timestamp/);
  assert.throws(() => validateRegistryCatalog({ ...valid, signature: "bad" }), /canonical Ed25519/);

  const duplicate = { ...valid, plugins: [valid.plugins[0], { ...valid.plugins[0] }] };
  assert.throws(() => validateRegistryCatalog(duplicate), /Duplicate plugin id/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ id: "Invalid_ID!" })), /Invalid plugin id/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ version: "1.0" })), /semantic versioning/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ version: "1.0.0-01" })), /semantic versioning/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ version: "99999999999999999999.0.0" })), /semantic versioning/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ unexpected: true })), /unsupported fields/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    platforms: [{ os: "linux", architectures: ["x64"] }, { os: "linux", architectures: ["arm64"] }],
  })), /duplicate platform/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    platforms: [{ os: "linux", architectures: ["x64", "x64"] }],
  })), /architectures are invalid/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    resources: { memoryMB: 1, diskMB: 1, accelerators: ["cpu", "cpu"] },
  })), /accelerators are invalid/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    permissions: { network: [], filesystem: ["scoped-temp", "scoped-temp"], secrets: [], subprocess: false },
  })), /filesystem permissions are invalid/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ manifestUrl: "https://evil.example/manifest.json" })), /canonical versioned/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ downloadBaseUrl: `${releaseRoot}/nested/` })), /ending with/);

  assert.throws(() => validateRegistryCatalog(catalogForValidation({ files: [] })), /1-10000/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    files: [{ ...valid.plugins[0].files[0], extra: true }],
  })), /unsupported fields/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    files: [{ ...valid.plugins[0].files[0], path: "../plugin.mjs" }],
  })), /Unsafe plugin path/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    files: [valid.plugins[0].files[0], { ...valid.plugins[0].files[0] }],
    downloadSize: valid.plugins[0].downloadSize * 2,
  })), /Duplicate file path/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({
    files: [{ ...valid.plugins[0].files[0], url: "https://evil.example/plugin.mjs" }],
  })), /canonical versioned/);
  assert.throws(() => validateRegistryCatalog(catalogForValidation({ downloadSize: 1 })), /must equal its declared file sizes/);
});

test("streams one bounded GitHub asset redirect and rejects every other redirect shape", async () => {
  const initialUrl = assetUrl("catalog.json");
  const targetUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/123/catalog?sp=r&sig=a%2Fb";
  const calls = [];
  const redirected = await fetchBoundedText(async (url, options) => {
    calls.push({ url, options });
    if (url === initialUrl) return new Response(null, { status: 302, headers: { location: targetUrl } });
    return new Response("hello");
  }, initialUrl, {}, 1000);
  assert.equal(redirected, "hello");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal("timeoutMs" in calls[0].options, false);

  await assert.rejects(fetchBoundedBuffer(async () => {}, "https://evil.example/catalog.json"), /Untrusted plugin download URL/);
  await assert.rejects(fetchBoundedBuffer(async () => ({
    status: 302, ok: false, headers: { get: () => null },
  }), initialUrl), /missing Location/);
  await assert.rejects(fetchBoundedBuffer(async () => ({
    status: 302, ok: false, headers: { get: () => "https://evil.example/asset" },
  }), initialUrl), /must target credential-free/);
  let hop = 0;
  await assert.rejects(fetchBoundedBuffer(async () => {
    hop += 1;
    return {
      status: 302,
      ok: false,
      headers: { get: () => targetUrl },
      body: { cancel: async () => {} },
    };
  }, initialUrl), /Second plugin download redirect/);
  assert.equal(hop, 2);
  await assert.rejects(fetchBoundedBuffer(async () => new Response("missing", { status: 404 }), initialUrl), /HTTP 404/);
});

test("enforces declared and actual response bounds", async () => {
  const initialUrl = assetUrl("plugin.mjs");
  for (const contentLength of ["-1", "1.5", "nope", "99999999999999999999"]) {
    await assert.rejects(fetchBoundedBuffer(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => contentLength },
      arrayBuffer: async () => Buffer.from("ok"),
    }), initialUrl, {}, 1000), /invalid Content-Length/);
  }
  await assert.rejects(fetchBoundedBuffer(async () => ({
    status: 200,
    ok: true,
    headers: { get: () => "2000" },
    arrayBuffer: async () => new ArrayBuffer(2000),
  }), initialUrl, {}, 1000), /exceeded maximum allowable size/);

  let reads = 0;
  let cancelled = false;
  await assert.rejects(fetchBoundedBuffer(async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => reads++ === 0
        ? { done: false, value: new Uint8Array(1001) }
        : { done: true },
      cancel: async () => { cancelled = true; },
      releaseLock: () => {},
    }) },
  }), initialUrl, {}, 1000), /exceeded maximum allowable size of 1000 bytes/);
  assert.equal(cancelled, true);

  const body = await fetchBoundedBuffer(async () => new Response("hello"), initialUrl, {}, 1000);
  assert.equal(body.toString("utf8"), "hello");
  await assert.rejects(fetchBoundedBuffer(fetch, initialUrl, {}, 0), /size limit is invalid/);
});

test("keeps caller cancellation and timeout active through response streaming", async () => {
  const initialUrl = assetUrl("plugin.mjs");
  const stalledResponse = cancelled => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: async () => cancelled(),
      releaseLock: () => {},
    }) },
  });

  const controller = new AbortController();
  const reason = Object.assign(new Error("stop registry request"), { name: "AbortError" });
  let callerCancelled = false;
  const pending = fetchBoundedBuffer(
    async () => stalledResponse(() => { callerCancelled = true; }),
    initialUrl,
    { signal: controller.signal, timeoutMs: 5_000 },
  );
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(pending, error => error === reason);
  assert.equal(callerCancelled, true);

  let timeoutCancelled = false;
  await assert.rejects(
    fetchBoundedBuffer(
      async () => stalledResponse(() => { timeoutCancelled = true; }),
      initialUrl,
      { timeoutMs: 20 },
    ),
    error => error.name === "TimeoutError" && /timed out after 20 ms/.test(error.message),
  );
  assert.equal(timeoutCancelled, true);
});

test("compares semantic versions and identifies security confirmation reasons", () => {
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0-beta.1"), 1);
  assert.throws(() => compareSemver("not-semver", "1.0.0"), /Invalid semver comparison/);

  const benign = { permissions: { network: [], secrets: [], subprocess: false, filesystem: ["scoped-temp"] } };
  assert.equal(checkPluginSecurityConfirmations(benign).requiresConfirmation, false);
  const elevated = {
    permissions: {
      network: ["https://api.example.com"],
      secrets: ["API_TOKEN"],
      subprocess: true,
      filesystem: ["scoped-temp", "persistent-data"],
    },
  };
  const check = checkPluginSecurityConfirmations(elevated, null, LARGE_DOWNLOAD_THRESHOLD);
  assert.equal(check.requiresConfirmation, true);
  assert.equal(check.reasons.length, 5);
  assert.deepEqual(check.details.newNetwork, ["https://api.example.com"]);
  assert.deepEqual(check.details.newSecrets, ["API_TOKEN"]);
  assert.deepEqual(check.details.newElevatedFs, ["persistent-data"]);
  assert.equal(check.details.subprocess, true);
  assert.equal(check.details.largeDownload, true);
  assert.equal(check.details.downloadBytes, LARGE_DOWNLOAD_THRESHOLD);
  assert.equal(checkPluginSecurityConfirmations(elevated, elevated, 1).requiresConfirmation, false);
});
