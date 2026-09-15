# First-party OCR plugins

Quizzer's OCR host contract stays deliberately small: an OCR plugin receives one bounded PNG, JPEG, or WebP file through its scoped temporary directory and returns `{ "text": "..." }`. The application already lets users select exactly one installed `ocr` component in **Plugins & models > Image OCR**.

| Plugin | Where it runs | Data leaves the device? | Requirements |
| --- | --- | --- | --- |
| RapidOCR | Local, managed by Quizzer | No | Existing built-in balanced option |
| Tesseract OCR | Local | No | Tesseract 5 executable on `PATH`; defaults to `eng` |
| Apple Vision OCR | Local, macOS only | No | macOS Vision framework; no extra model download |
| Google Cloud Vision OCR | Remote | **Yes** | `GOOGLE_CLOUD_VISION_API_KEY`; provider usage may be billed |
| AWS Textract OCR | Remote | **Yes** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; optional `AWS_SESSION_TOKEN` and `AWS_REGION`; provider usage may be billed |

Cloud credentials are forwarded only when the selected plugin explicitly declares the corresponding secret name in its signed manifest. Other environment variables are not copied into the plugin process. Remote plugins also declare their network destinations, so the normal registry install confirmation surfaces both network and secret access before installation.

## Packaging for the signed registry

Source manifests in this directory remain unsigned so contributors can inspect and test them. Release publication signs fresh copies without modifying source files:

```sh
export QUIZZER_PLUGIN_REGISTRY_PRIVATE_KEY='<base64 PKCS#8 DER or PEM Ed25519 private key>'
export QUIZZER_PLUGIN_REGISTRY_PUBLIC_KEY_ID='release-2026'
node scripts/build-ocr-plugin-registry.mjs
```

The command writes `dist/plugin-registry/` containing a signed `catalog.json`, one signed manifest per OCR plugin, and immutable plugin assets. Upload those files to the release tag selected by `QUIZZER_PLUGIN_REGISTRY_TAG` (default `plugins-v1`). The catalog URLs use Quizzer's existing canonical GitHub Release contract, so install, update, rollback, platform checks, hash verification, and permission confirmation continue to use the standard plugin lifecycle.

Tesseract is intentionally a thin adapter rather than a bundled native binary. That avoids silently shipping platform-specific executables and language packs under one generic artifact. A future release pipeline may produce fully self-contained, platform-specific Tesseract packages if clean-machine testing justifies the extra maintenance.

PaddleOCR remains a benchmark/packaging candidate rather than a first-wave plugin. Its runtime and model distribution should only be added if a self-contained build stays comfortably inside the registry's 64 MiB-per-file and 256 MiB-total limits and materially beats the lighter choices on Quizzer's document-image workload.
