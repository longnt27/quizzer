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
| `reranker` | `rag.rerank` | `{ "ranking": [{ "sourceSpanId": "…", "score": 0.9 }] }` |
| `generator` | `generation.generate` | `{ "output": "{\"questions\":[]}" }` |

Extractor and OCR plugins must declare both `scoped-temp` and `document-read`. Input paths are relative to `temporaryDirectory`; never assume access to the original library path. Extractor images must be PNG, JPEG, or WebP base64 payloads and are revalidated and moved into Quizzer’s content-addressed object store. Current protocol limits are one 250 MB extractor source, 8 MiB of extracted text, 30 images, 8 MiB per image, 20 MiB across images, and 100,000 OCR characters.

Generator plugins that accept source images must declare `scoped-temp`. Embedder and reranker inputs are sent inline because their bounded text payloads are smaller. Every plugin should implement the manifest’s `healthCheck.method` and return a small JSON object describing readiness.

Secrets are copied into the plugin environment only when their names appear in `permissions.secrets` and the user has configured them. Quizzer does not forward its full environment, service token, provider credentials, or document-library paths.
