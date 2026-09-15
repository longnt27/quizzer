# First-party OCR plugins

Quizzer's OCR host contract stays deliberately small: an OCR plugin receives one bounded PNG, JPEG, or WebP file through its scoped temporary directory and returns `{ "text": "..." }`. The application lets users select exactly one installed `ocr` component in **Plugins & models > Image OCR**.

| Plugin | Where it runs | Data leaves the device? | Requirements |
| --- | --- | --- | --- |
| RapidOCR | Local, managed by Quizzer | No | Existing built-in balanced option |
| Tesseract OCR | Local | No | None; Quizzer ships Tesseract 5.5.3 plus English `tessdata_fast` |
| Apple Vision OCR | Local, macOS only | No | macOS Vision framework; no extra model download |
| Google Cloud Vision OCR | Remote | **Yes** | `GOOGLE_CLOUD_VISION_API_KEY`; provider usage may be billed |
| AWS Textract OCR | Remote | **Yes** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; optional `AWS_SESSION_TOKEN` and `AWS_REGION`; provider usage may be billed |

Cloud credentials are forwarded only when the selected plugin explicitly declares the corresponding secret name in its signed manifest. Other environment variables are not copied into the plugin process. Remote plugins also declare their network destinations, so the normal registry install confirmation surfaces both network and secret access before installation.

## Bundled Tesseract

`quizzer.ocr.tesseract` is self-contained. It never searches the user's `PATH` and does not require Homebrew, apt, Chocolatey, or a separate Tesseract installation. At runtime the adapter selects the native executable from its own signed plugin directory and points Tesseract at the bundled English language data.

The first bundled release supports:

- macOS x64 (`darwin-x64`)
- macOS Apple Silicon (`darwin-arm64`)
- Linux x64 (`linux-x64`)
- Linux ARM64 (`linux-arm64`)
- Windows x64 (`win32-x64`)

Windows ARM64 is intentionally not advertised until the release pipeline can build and exercise it. The bundled language set is intentionally English-only (`eng`) for the first release. Additional languages should be added as explicit signed language-pack work rather than silently making every user download the full Tesseract language catalog.

The native release inputs are pinned in `.github/workflows/ocr-plugin-registry.yml`:

- Tesseract 5.5.3 source commit `db0ec62f81b0737fbbe184d8fea40af5738f8eef`
- vcpkg commit `9e44ec0e9f247d77c230ced0ee66c76296837807`
- `tessdata_fast` commit `87416418657359cb625c412a48b6e1d6d41c29bd`
- Leptonica license/source revision `13275a278eb55b5746e33f95fbf5a2c8f604b3ab`

Each native target is built from source with static image-processing dependencies, executes `tesseract --version`, performs real OCR against Tesseract's pinned `phototest.tif` fixture using the bundled English model, and receives a platform-specific dependency audit (`ldd`, `otool -L`, or `dumpbin /DEPENDENTS`). The workflow then assembles all five runtimes, `eng.traineddata`, and the Tesseract, Leptonica, and `tessdata_fast` license notices into the payload consumed by the signed registry builder.

## Packaging for the signed registry

Source manifests in this directory remain unsigned so contributors can inspect and test them. The Tesseract source manifest contains only the adapter; `scripts/build-ocr-plugin-registry.mjs` derives the release manifest from the actual assembled native bundle, computes SHA-256 hashes for every runtime/model/license asset, and refuses to sign an incomplete, symlinked, empty, oversized, or otherwise invalid bundle.

The dedicated **OCR Plugin Registry** GitHub Actions workflow is the canonical build path. Pull requests build and validate the native bundle with an ephemeral signing key but do not publish anything. Production publication is a protected manual `workflow_dispatch` action with `publish=true`, using the `release` environment and the configured registry signing key, and updates the `plugins-v1` GitHub Release.

For local/manual registry assembly, first provide a complete bundle with the same directory layout produced by CI, then run:

```sh
export QUIZZER_PLUGIN_REGISTRY_PRIVATE_KEY='<base64 PKCS#8 DER or PEM Ed25519 private key>'
export QUIZZER_PLUGIN_REGISTRY_PUBLIC_KEY_ID='release-2026'
export QUIZZER_TESSERACT_BUNDLE_DIRECTORY='/absolute/path/to/tesseract-bundle'
node scripts/build-ocr-plugin-registry.mjs
```

The command writes `dist/plugin-registry/` containing a signed `catalog.json`, one signed manifest per OCR plugin, and immutable plugin assets. The catalog URLs use Quizzer's existing canonical GitHub Release contract, so install, update, rollback, platform checks, hash verification, and permission confirmation continue to use the standard plugin lifecycle.

PaddleOCR remains a benchmark/packaging candidate rather than a first-wave plugin. Its runtime and model distribution should only be added if a self-contained build stays comfortably inside the registry's 64 MiB-per-file and 256 MiB-total limits and materially beats the lighter choices on Quizzer's document-image workload.
