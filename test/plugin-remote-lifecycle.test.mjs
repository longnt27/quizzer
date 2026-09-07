import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager } from "../plugin-sdk/manager.mjs";
import { pluginSignaturePayload } from "../plugin-sdk/manifest.mjs";
import { signRegistryCatalog } from "../plugin-sdk/registry.mjs";

const testDirectory = await mkdtemp(join(tmpdir(), "quizzer-remote-lifecycle-test-"));
const appDataDirectory = join(testDirectory, "app-data");
await mkdir(appDataDirectory, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = "registry-signer-2026";
const trustedKeys = {
  [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
};

test.after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

// Setup mock assets and mock fetch
const pluginFileSourceV1 = "process.stdin.pipe(process.stdout);\n";
const pluginHashV1 = createHash("sha256").update(pluginFileSourceV1).digest("hex");

const manifestV1Unsigned = {
  schemaVersion: 1,
  id: "test-echo",
  name: "Test Echo Plugin",
  description: "Test Echo Plugin v1",
  version: "1.0.0",
  protocolVersion: 1,
  entrypoint: "plugin.mjs",
  capabilities: ["generator"],
  platforms: [{ os: process.platform, architectures: [process.arch] }],
  resources: { memoryMB: 64, diskMB: 2 },
  configuration: { type: "object" },
  permissions: { network: [], filesystem: ["scoped-temp"], secrets: [], subprocess: false },
  healthCheck: { method: "plugin.health", timeoutMs: 2000 },
  files: [{ path: "plugin.mjs", sha256: pluginHashV1 }],
};

const signedManifestV1 = {
  ...manifestV1Unsigned,
  signature: {
    algorithm: "ed25519",
    keyId,
    value: sign(null, pluginSignaturePayload(manifestV1Unsigned), privateKey).toString("base64"),
  },
};

const pluginFileSourceV2 = "process.stdin.pipe(process.stdout); // v2\n";
const pluginHashV2 = createHash("sha256").update(pluginFileSourceV2).digest("hex");

const manifestV2Unsigned = {
  schemaVersion: 1,
  id: "test-echo",
  name: "Test Echo Plugin",
  description: "Test Echo Plugin v2",
  version: "2.0.0",
  protocolVersion: 1,
  entrypoint: "plugin.mjs",
  capabilities: ["generator"],
  platforms: [{ os: process.platform, architectures: [process.arch] }],
  resources: { memoryMB: 64, diskMB: 2 },
  configuration: { type: "object" },
  permissions: { network: ["https://api.example.com"], filesystem: ["scoped-temp"], secrets: [], subprocess: false },
  healthCheck: { method: "plugin.health", timeoutMs: 2000 },
  files: [{ path: "plugin.mjs", sha256: pluginHashV2 }],
};

const signedManifestV2 = {
  ...manifestV2Unsigned,
  signature: {
    algorithm: "ed25519",
    keyId,
    value: sign(null, pluginSignaturePayload(manifestV2Unsigned), privateKey).toString("base64"),
  },
};

const unsignedManifestV1 = { ...manifestV1Unsigned };

let catalogVersion = "1.0.0";
let activeManifest = signedManifestV1;
let activeSource = pluginFileSourceV1;

const mockFetch = async (url) => {
  if (url === "https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json") {
    const rawCatalog = {
      schemaVersion: 1,
      version: "2026.09.01",
      publishedAt: "2026-09-01T00:00:00.000Z",
      signatureAlgorithm: "ed25519",
      publicKeyId: keyId,
      plugins: [
        {
          id: "test-echo",
          name: "Test Echo Plugin",
          version: catalogVersion,
          description: "Test Echo description",
          capabilities: ["generator"],
          platforms: [{ os: process.platform, architectures: [process.arch] }],
          resources: { memoryMB: 64, diskMB: 2 },
          permissions: catalogVersion === "1.0.0" ? manifestV1Unsigned.permissions : manifestV2Unsigned.permissions,
          manifestUrl: "https://github.com/Somethings1/quizzer/releases/download/plugins/test-echo.manifest.json",
          downloadBaseUrl: "https://github.com/Somethings1/quizzer/releases/download/plugins/",
          downloadSize: 1024,
        },
        {
          id: "incompatible-plugin",
          name: "Incompatible Plugin",
          version: "1.0.0",
          capabilities: ["embedder"],
          platforms: [{ os: process.platform === "linux" ? "win32" : "linux", architectures: ["x64"] }],
          resources: { memoryMB: 64, diskMB: 2 },
          permissions: { network: [], filesystem: ["scoped-temp"], secrets: [], subprocess: false },
          manifestUrl: "https://github.com/Somethings1/quizzer/releases/download/plugins/incompatible.manifest.json",
        },
      ],
    };
    const signed = signRegistryCatalog(rawCatalog, privateKey);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify(signed),
      arrayBuffer: async () => Buffer.from(JSON.stringify(signed)),
    };
  }

  if (url === "https://github.com/Somethings1/quizzer/releases/download/plugins/test-echo.manifest.json") {
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify(activeManifest),
      arrayBuffer: async () => Buffer.from(JSON.stringify(activeManifest)),
    };
  }

  if (url === "https://github.com/Somethings1/quizzer/releases/download/plugins/plugin.mjs") {
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => activeSource,
      arrayBuffer: async () => Buffer.from(activeSource),
    };
  }

  return {
    status: 404,
    ok: false,
    headers: { get: () => null },
  };
};

test("PluginManager remote lifecycle: list, install, update, rollback, and remove", async () => {
  const manager = new PluginManager({
    appDataDirectory,
    trustedKeys,
    trustedRegistryKeys: trustedKeys,
    fetch: mockFetch,
    developerMode: false,
  });

  // 1. List Registry
  const registryItems = await manager.listRegistry();
  assert.equal(registryItems.length, 2);
  const echoEntry = registryItems.find(p => p.id === "test-echo");
  assert.ok(echoEntry);
  assert.equal(echoEntry.installed, false);
  assert.equal(echoEntry.compatible, true);

  const incompEntry = registryItems.find(p => p.id === "incompatible-plugin");
  assert.ok(incompEntry);
  assert.equal(incompEntry.compatible, false);

  // 2. Reject install of incompatible plugin
  await assert.rejects(
    () => manager.installFromRegistry("incompatible-plugin"),
    /does not support/
  );

  // 3. Reject install of unsigned plugin even if Developer Mode is enabled
  activeManifest = unsignedManifestV1;
  const devManager = new PluginManager({
    appDataDirectory,
    trustedKeys,
    trustedRegistryKeys: trustedKeys,
    fetch: mockFetch,
    developerMode: true,
  });
  await assert.rejects(
    () => devManager.installFromRegistry("test-echo"),
    /must be signed with a trusted key; unsigned registry plugins are prohibited/
  );

  // 4. Install signed plugin from registry (v1.0.0 requires no elevated permissions)
  activeManifest = signedManifestV1;
  activeSource = pluginFileSourceV1;
  catalogVersion = "1.0.0";

  const installed = await manager.installFromRegistry("test-echo");
  assert.equal(installed.id, "test-echo");
  assert.equal(installed.version, "1.0.0");
  assert.equal(installed.source, "registry");
  assert.equal(installed.trust, "signed");
  assert.equal(installed.enabled, true);

  // State verification: persisted without secrets
  const state = JSON.parse(await readFile(join(appDataDirectory, "plugins", "state.json"), "utf8"));
  assert.equal(state.plugins["test-echo"].source, "registry");
  assert.equal(state.plugins["test-echo"].registryId, "test-echo");
  assert.equal(state.plugins["test-echo"].version, "1.0.0");

  // Verify list() reflects registry source
  const installedList = await manager.list();
  const listMatch = installedList.find(p => p.id === "test-echo");
  assert.equal(listMatch.source, "registry");
  assert.equal(listMatch.updateAvailable, false);

  // 5. Check health check
  const health = await manager.health("test-echo");
  assert.equal(health.ok, true);

  // 6. Update available detection
  catalogVersion = "2.0.0";
  activeManifest = signedManifestV2;
  activeSource = pluginFileSourceV2;

  const registryAfterV2 = await manager.listRegistry();
  const echoV2Registry = registryAfterV2.find(p => p.id === "test-echo");
  assert.equal(echoV2Registry.installed, true);
  assert.equal(echoV2Registry.installedVersion, "1.0.0");
  assert.equal(echoV2Registry.updateAvailable, true);

  const installedAfterV2 = await manager.list();
  const echoV2Installed = installedAfterV2.find(p => p.id === "test-echo");
  assert.equal(echoV2Installed.updateAvailable, true);
  assert.equal(echoV2Installed.availableVersion, "2.0.0");

  // 7. Update requires confirmation because v2 introduces network permission
  await assert.rejects(
    () => manager.update("test-echo", { confirmed: false }),
    (err) => err.confirmationRequired === true && err.reasons.length > 0
  );

  // 8. Update with confirmation: true
  const updated = await manager.update("test-echo", { confirmed: true });
  assert.equal(updated.version, "2.0.0");

  // Verify list() after update
  const listAfterUpdate = await manager.list();
  const updatedEntry = listAfterUpdate.find(p => p.id === "test-echo");
  assert.equal(updatedEntry.version, "2.0.0");
  assert.equal(updatedEntry.updateAvailable, false);

  // When already up to date, manager.update reports updated: false
  const noopUpdate = await manager.update("test-echo", { confirmed: true });
  assert.equal(noopUpdate.updated, false);

  // 9. Rollback to v1.0.0
  const rolledBack = await manager.rollback("test-echo");
  assert.equal(rolledBack.id, "test-echo");
  assert.equal(rolledBack.version, "1.0.0");
  assert.equal(rolledBack.enabled, false);

  // State reflects rolled back version
  const listAfterRollback = await manager.list();
  const rolledBackEntry = listAfterRollback.find(p => p.id === "test-echo");
  assert.equal(rolledBackEntry.version, "1.0.0");
  assert.equal(rolledBackEntry.enabled, false);

  // Enable again
  const reenabled = await manager.setEnabled("test-echo", true);
  assert.equal(reenabled.enabled, true);

  // 10. Recoverable removal
  const removed = await manager.remove("test-echo");
  assert.equal(removed.removed, true);
  assert.ok(removed.recoveryPath);

  const listAfterRemove = await manager.list();
  assert.equal(listAfterRemove.some(p => p.id === "test-echo"), false);
});
