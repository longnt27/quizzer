# Quizzer Signed Plugin Registry & Remote Lifecycle

Quizzer features a secure, signed plugin registry system designed to safely discover, install, update, and rollback out-of-process plugins without relying on Developer Mode.

## Security Architecture & Threat Model

The plugin registry system is built on a strict defense-in-depth model:

1. **Versioned Registry Catalog Contract (`quizzer.catalog.schema.json`)**:
   - The catalog contract conforms to schemaVersion `1`.
   - The catalog payload is signed with an **Ed25519** cryptographic signature.
   - The signature is verified against explicitly configured trusted keys before any catalog entry, version, or URL is parsed or trusted.

2. **Canonical Download URL Restriction**:
   - Downloads are strictly restricted to canonical credential-free HTTPS Quizzer GitHub Release URLs (`https://github.com/Somethings1/quizzer/releases/download/...` or `/releases/latest/download/...`).
   - URLs containing credentials (`user:pass@`), non-HTTPS protocols, or path traversal elements (`..`, `\\`) are rejected immediately.

3. **Disabled Redirects**:
   - HTTP redirects are disabled (`redirect: "error"`). Any 3xx redirect response immediately aborts the download to prevent open-redirect and domain spoofing attacks.

4. **Strict Size Bounds**:
   - **Catalog:** Maximum 1 MiB (`MAX_CATALOG_SIZE`).
   - **Manifest:** Maximum 512 KiB (`MAX_MANIFEST_SIZE`).
   - **Individual File:** Maximum 64 MiB (`MAX_INDIVIDUAL_FILE_SIZE`).
   - **Total Plugin Size:** Maximum 256 MiB (`MAX_TOTAL_PLUGIN_SIZE`).
   - Responses exceeding content-length or streamed byte limits are aborted immediately.

5. **Platform & Architecture Compatibility**:
   - Registry entries explicitly declare supported operating systems (`darwin`, `linux`, `win32`) and CPU architectures (`x64`, `arm64`).
   - Incompatible plugins are rejected prior to download and cannot be installed on unsupported environments.

6. **Pre-installation Verification**:
   - The downloaded `quizzer.plugin.json` manifest signature is verified with Ed25519 against trusted keys.
   - Registry installs **must never enable unsigned plugins or depend on Developer Mode**. Even with Developer Mode active, remote registry plugins must be validly signed.
   - Every declared file in the manifest is hashed with SHA-256 and matched against the manifest entry before an atomic directory swap is made.

7. **Atomic Installation & Rollback Invariance**:
   - New versions are downloaded and verified in isolated staging directories.
   - When updating an installed plugin, the existing version is backed up to `plugins/rollback/<id>--<version>--<timestamp>`.
   - If an error occurs during directory replacement, the backup is automatically restored.
   - Manual rollback restores the previous version disabled (`enabled: false`) for administrative inspection.

8. **Clean State Persistence**:
   - Plugin state is stored in `plugins/state.json` containing metadata: `source` (`registry` vs `local`), `registryId`, `version`, and `availableVersion`.
   - No API keys, credentials, or secrets are stored in `state.json`.

9. **Explicit Security Confirmation**:
   - Both the CLI (`--yes`) and Advanced UI (`Modal.confirm`) require explicit user confirmation before installing or updating plugins that request:
     - Network access (`permissions.network`)
     - Secret access (`permissions.secrets`)
     - Subprocess execution (`permissions.subprocess`)
     - Elevated filesystem permissions (`persistent-data`, `document-read`, `model-read`)
     - Large downloads (>= 25 MiB)

---

## Configuration

Trusted keys and registry URLs are configured via environment variables or settings:

- `QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS`: JSON object mapping key IDs to Ed25519 public keys (PEM, base64 DER, or JWK).
  Example:
  ```bash
  export QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS='{"release-2026":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}'
  ```
- `QUIZZER_PLUGIN_TRUSTED_KEYS`: Fallback trusted keys object if `QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS` is not set.
- `QUIZZER_PLUGIN_REGISTRY_URL`: Custom URL for the registry catalog. Defaults to:
  `https://github.com/Somethings1/quizzer/releases/download/plugins/catalog.json`

---

## CLI Usage

### List Plugins
```bash
# List installed external plugins with version, status, source, and update availability
quizzer plugins list

# List available plugins from the signed remote registry
quizzer plugins list --registry
```

### Install Plugin
```bash
# Install local directory (requires Developer Mode if unsigned)
quizzer plugins install ./my-local-plugin

# Install from signed registry by ID (requires --yes if requesting permissions or >=25MB)
quizzer plugins install fast-embedder --yes
```

### Update Plugin
```bash
# Check and update an installed plugin to the latest version in the registry
quizzer plugins update fast-embedder --yes
```

### Health Check & Status
```bash
quizzer plugins health fast-embedder
```

### Rollback
```bash
# Rollback to the previous version; restored version is disabled until reviewed
quizzer plugins rollback fast-embedder
quizzer plugins enable fast-embedder
```

### Enable / Disable
```bash
quizzer plugins disable fast-embedder
quizzer plugins enable fast-embedder
```

### Recoverable Removal
```bash
# Move plugin to recoverable storage (plugins/removed/...)
quizzer plugins remove fast-embedder --yes
```

---

## HTTP & OpenAPI Endpoints

The authenticated Quizzer API provides endpoints corresponding to each lifecycle operation:

- `GET /api/v1/plugins/registry` (or `GET /api/v1/plugins?registry=true`): Fetch verified registry catalog entries.
- `GET /api/v1/plugins`: List installed external and built-in plugins with `source`, `registryId`, `availableVersion`, and `updateAvailable`.
- `POST /api/v1/plugins/install`: Install via `{ "id": "plugin-id", "confirmed": true }` or `{ "path": "/path/to/dir" }`.
- `POST /api/v1/plugins/:id/update`: Update installed plugin with optional `{ "confirmed": true }`.
- `POST /api/v1/plugins/:id/(enable|disable|health|rollback)`: Manage plugin state.
- `DELETE /api/v1/plugins/:id?confirm=true`: Move plugin to recoverable storage.

---

## Signing a Catalog for Distribution

Registry maintainers publish catalogs using the SDK signing utility:

```javascript
import { signRegistryCatalog } from "./plugin-sdk/registry.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const rawCatalog = JSON.parse(readFileSync("catalog.unsigned.json", "utf8"));
const privateKeyPem = readFileSync("registry-private-key.pem", "utf8");

const signedCatalog = signRegistryCatalog(rawCatalog, privateKeyPem);
writeFileSync("catalog.json", JSON.stringify(signedCatalog, null, 2) + "\n");
```
