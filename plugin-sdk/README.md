# Quizzer plugin SDK protocol v1

Quizzer plugins are separate executables described by `quizzer.plugin.json`. The manifest schema is [`quizzer.plugin.schema.json`](quizzer.plugin.schema.json). Every installed file is hash-verified; signed manifests must use a configured Ed25519 registry key, while unsigned local plugins require Advanced Developer Mode.

Quizzer starts one plugin process per invocation and sends one JSON-RPC 2.0 request on standard input. The request includes the declared method and parameters plus this context:

```json
{
  "temporaryDirectory": "/private/quizzer/plugin-temp/example-123",
  "scopedFiles": [{ "path": "input/document.pdf", "size": 12000 }],
  "configuration": {},
  "protocolVersion": 1
}
```

Return one newline-terminated response with the same request ID. Quizzer bounds standard output, captures only bounded diagnostic output, forwards cancellation by terminating the process, and removes the temporary directory after exit.

```json
{"jsonrpc":"2.0","id":"request-id","result":{"status":"ready"}}
```

## Capability methods

| Capability | Method | Result envelope |
| --- | --- | --- |
| `extractor` | `document.extract` | `{ "content": "…", "pageCount": 3, "parserVersion": "engine-1", "images": [] }` |
| `ocr` | `document.ocr` | `{ "text": "recognized text" }` |
| `embedder` | `rag.embed` | `{ "embeddings": [[0.1, 0.2]] }` |
| `vector-index` | `rag.index`, `rag.search`, `rag.remove`, `rag.status` | Bounded index confirmations, stable-span matches, removal counts, and status |
| `reranker` | `rag.rerank` | `{ "ranking": [{ "sourceSpanId": "…", "score": 0.9 }] }` |
| `generator` | `generation.generate` | `{ "output": "{\"questions\":[]}" }` |

Extractor and OCR plugins must declare both `scoped-temp` and `document-read`. Input paths are relative to `temporaryDirectory`; never assume access to the original library path. Extractor images must be PNG, JPEG, or WebP base64 payloads and are revalidated and moved into Quizzer’s content-addressed object store. Current protocol limits are one 250 MB extractor source, 8 MiB of extracted text, 30 images, 8 MiB per image, 20 MiB across images, and 100,000 OCR characters.

Generator plugins that accept source images must declare `scoped-temp`. Embedder and reranker inputs are sent inline because their bounded text payloads are smaller. Every plugin should implement the manifest’s `healthCheck.method` and return a small JSON object describing readiness.

Vector-index plugins must declare both `scoped-temp` and `persistent-data`. Quizzer sends `rag.index` a relative `payloadPath` containing bounded JSON rows with stable source-span metadata and host-produced vectors; original document paths and text are not included. It must atomically replace or reuse the named document/version and return `{ "reused": false, "chunks": 12 }`, making a repeated call idempotent after interruption. `rag.search` receives one vector, its embedding-model identity, optional document IDs, and a limit, and returns `{ "matches": [{ "sourceSpanId": "…", "documentId": "…", "tags": [], "score": 0.9 }] }`. `rag.remove` returns `{ "removedChunks": 12 }`. `rag.status` returns non-negative `tableCount`, `chunkCount`, `activeTableCount`, and `activeChunkCount` with a bounded `engine` name. Persistent data is private to the plugin at `context.persistentDataDirectory` and `QUIZZER_PLUGIN_DATA_DIR`; it survives plugin updates, rollback, and recoverable removal because it is derived data that may be rebuilt after reinstall. Plugins without the permission receive neither field.

Secrets are copied into the plugin environment only when their names appear in `permissions.secrets` and the user has configured them. Quizzer does not forward its full environment, service token, provider credentials, or document-library paths.

## Signed Plugin Registry Catalog Contract

Quizzer supports distribution through signed plugin registries defined by [`quizzer.catalog.schema.json`](quizzer.catalog.schema.json). Catalogs are signed using Ed25519 and verified against configured trusted keys (`QUIZZER_PLUGIN_REGISTRY_TRUSTED_KEYS`).

- All release assets must be served from canonical versioned credential-free HTTPS GitHub Release URLs (`https://github.com/longnt27/quizzer/releases/download/<tag>/...`). Unversioned `/latest/` URLs are prohibited.
- Manual redirects are strictly bounded: at most one HTTPS 30x hop to credential-free `release-assets.githubusercontent.com` on the default port is accepted. Arbitrary hosts/ports, missing Location, and second redirect hops are rejected.
- Every catalog file URL, SHA-256, and size is signed. File sizes must sum to `downloadSize`, catalog metadata must match the signed plugin manifest, and downloaded bytes must match both per-file and total declarations.
- Permission and large-download approval in the desktop UI uses a service-issued, manifest-bound confirmation token so stale client previews cannot authorize changed content.
- Operating system and architecture compatibility are validated prior to download.
- Full details are documented in [docs/plugin-registry.md](../docs/plugin-registry.md).
