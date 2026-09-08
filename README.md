# Quizzer

[![CI](https://github.com/Somethings1/quizzer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Somethings1/quizzer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Somethings1/quizzer?include_prereleases&sort=semver)](https://github.com/Somethings1/quizzer/releases)
[![License](https://img.shields.io/github/license/Somethings1/quizzer)](LICENSE)
[![Security policy](https://img.shields.io/badge/security-policy-2ea44f)](SECURITY.md)

Quizzer is a local-first desktop application and CLI that turns your PDF, Markdown, and text library into evidence-backed quizzes. Import a document once, then create focused tests with citations, custom learning goals, durable progress, and your choice of local models, signed-in coding agents, or API providers.

> [!IMPORTANT]
> Quizzer is preparing its first public beta. No installer has been published yet. Until one appears on [GitHub Releases](https://github.com/Somethings1/quizzer/releases), build from source and do not rely on the commands below. Beta downloads use a Quizzer-signed manifest and verified checksums, but currently have no paid Apple notarization or Windows publisher certificate; the installer reports that limitation explicitly.

The current beta foundation includes a resumable first-run walkthrough, reversible Simple and Advanced modes, hardware-aware Lite/Balanced/Max profiles, per-test learning instructions, source-span provenance, and crash-safe indexing and generation. Existing libraries are preserved during upgrade and are not forced through first-run setup.

## Contents

- [Install](#install)
- [Supported systems](#supported-systems)
- [What Quizzer does](#what-quizzer-does)
- [Retrieval and question quality](#retrieval-and-question-quality)
- [Build from source](#build-from-source)
- [Provider setup](#provider-setup)
- [Creating a quiz](#creating-a-quiz)
- [Data and privacy](#data-and-privacy)
- [CLI and development commands](#cli-and-development-commands)
- [Contributing and support](#contributing-and-support)
- [Security](#security)

## Install

Once a validated release is published, macOS and Linux users can install the desktop app and standalone CLI per-user with:

```sh
curl -fsSL https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.3/install.sh | sh
```

On Windows, run this in PowerShell:

```powershell
irm https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.3/install.ps1 | iex
```

The scripts do not require Node.js, Python, or Git. They select the correct x64 or arm64 build, verify the Ed25519-signed release manifest and SHA-256 checksums, install `quizzer` on the user PATH, register the desktop application, and launch onboarding. Until native signing is enabled, macOS and Windows may show an unidentified-developer or unknown-publisher warning.

These scripts are the only supported distribution entrypoints. Quizzer is not published through npm, Homebrew, WinGet, or another package-manager repository. Native packages in a release bundle exist for installation and signed updates; users do not need a package manager.

## Supported systems

| Operating system | Architectures | Supported baseline |
| --- | --- | --- |
| Windows | x64, arm64 | Windows 10/11 on x64; Windows 11 on arm64 |
| macOS | Intel x64, Apple silicon | macOS 13 or newer |
| Linux | x64, arm64 | Current 64-bit Ubuntu/Debian and Fedora-class distributions |

Quizzer does not support 32-bit or obsolete operating systems. Lite is the CPU-only baseline. Local generation in Balanced or Max depends on the selected model's RAM, storage, and acceleration requirements; remote and signed-in agent providers remain available on lower-spec hardware.

## Screenshots

| Document library | Quiz creation |
| --- | --- |
| ![Document library with searchable tags and extracted content](docs/screenshots/document-library-light.jpg) | ![Dark-mode quiz creation from selected documents](docs/screenshots/quiz-creation-dark.jpg) |

| Mobile quiz | Mobile results |
| --- | --- |
| ![Responsive quiz-taking interface on mobile](docs/screenshots/mobile-quiz-dark.jpg) | ![Responsive test summary on mobile](docs/screenshots/mobile-summary-dark.jpg) |

## What Quizzer does

- **Build a reusable library.** Import PDF, Markdown, or text; inspect extraction; organize sources with tags; and retry individual failures without repeating successful work.
- **Generate grounded questions.** Create separate or combined quizzes with multiple-choice, fill-in-the-blank, reasoning, and coding questions. Every accepted question retains stable source provenance and citations.
- **Match the workflow to the user.** Simple mode presents a short source → goal → preset → privacy review flow. Advanced mode exposes coverage, prompts, RAG, provider routes, context budgets, concurrency, batching, and validation thresholds without changing stored capabilities.
- **Choose where AI runs.** Use Ollama or llama.cpp locally, existing Codex/Claude/Antigravity sign-in, supported APIs, custom OpenAI-compatible endpoints, or out-of-process generator plugins.
- **Resume safely.** Indexing, generation, quiz attempts, and practice sessions checkpoint durably. A restart, network failure, or quota limit preserves completed work and resumes only unfinished slots.
- **Review with evidence.** Practice mode provides immediate feedback, explanations, citations, and Ask AI retrieval scoped to the selected documents.
- **Scale retrieval by hardware.** Lite always provides SQLite FTS5/BM25. Balanced and Max can add embeddings, LanceDB, hybrid fusion, reranking, OCR, visual extraction, and bounded local query planning.
- **Extend components safely.** Versioned plugins can provide extraction, OCR, embedding, vector indexing, reranking, and generation through cancellable JSON-RPC processes with explicit permissions.

## How it works

```text
PDF / Markdown / text
          │
          ▼
  Document extraction ──────► SQLite document library
  (Marker or fallback)          content + tags + figures
                                      │
                                      ▼
                              Select document(s)
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
           Local models          Signed-in agents            API providers
              Ollama        Codex · Claude · Antigravity   Gemini · Claude · OpenAI
                                                         OpenRouter · DeepSeek · OpenAI-compatible
                 └────────────────────┬──────────────────────────┘
                                      ▼
                         validate + reject duplicates
                                      ▼
                              saved local quiz
```

The React application never starts shell commands directly. It calls a loopback-only Node service, which invokes provider adapters, owns the SQLite library, and keeps API credentials outside browser bundles. The desktop process waits for that service before opening and restarts it with capped backoff after an unexpected exit. Each browser retains an IndexedDB cache so work remains usable during a short outage and synchronizes when the server returns.

## Retrieval and question quality

Quizzer does not ask a model to improvise a quiz from an entire file. It builds a retrieval plan for every coverage slot, supplies bounded evidence, validates the response, and saves only questions that pass.

```text
scope documents and tags
        ↓
FTS5/BM25 sparse search ──┐
                         ├─ reciprocal-rank fusion → rerank → MMR diversity
LanceDB dense search ─────┘                         ↓
                                      parent + neighboring context
                                                    ↓
                                  evidence-bounded question generation
                                                    ↓
                              schema · grounding · instruction · duplicate gates
```

- **Hybrid retrieval:** Lite always uses SQLite FTS5/BM25. Balanced and Max can add model-versioned LanceDB embeddings, metadata filtering, reciprocal-rank fusion, cross-encoder or plugin reranking, and maximal-marginal-relevance selection.
- **Structural context:** Documents are chunked around pages, headings, code blocks, tables, lists, and image anchors. Selected child spans can expand to their parent section and immediate neighbors without losing the stable source-span ID used for citations.
- **Coverage before generation:** The requested question mix becomes durable, unique coverage slots. Retrieval is performed for those slots, and a rejected candidate refills only its unfinished slot instead of regenerating accepted work.
- **Grounded questions:** Quizzer checks the question, correct answer, and explanation against retrieved evidence. It rejects ungrounded output, out-of-scope output, malformed schemas, and questions that do not follow a focused learning instruction.
- **Evidence-preserving citations:** Every accepted question records its documents, source spans, provider/model, and coverage slot. Practice feedback and Ask AI use the same scoped evidence rather than searching the whole library.
- **Honest refusal:** One corrective retrieval pass is allowed when evidence confidence is low. If evidence remains insufficient, Quizzer refuses instead of manufacturing an answer.

### How duplicate questions are eliminated

Duplicate prevention runs across every already accepted question, including questions produced in earlier provider calls or before a paused job resumed:

1. Statements are Unicode-normalized, lowercased, stripped of punctuation, and whitespace-collapsed; exact normalized matches are rejected.
2. Token-set similarity rejects lexical paraphrases at a Jaccard score of `0.82` or higher.
3. When embeddings are enabled, cosine similarity of `0.90` or higher rejects semantic paraphrases even when they use different wording.
4. Each accepted question must occupy a unique coverage slot. Rejected duplicates are checkpointed with their reason, and generation requests only a replacement for the missing slot.

The semantic layer is optional: Lite still gets exact and lexical protection, while Balanced and Max add embedding-based filtering. This keeps the baseline local and lightweight without silently disabling duplicate checks.

### Measured regression gates

The repository includes deterministic English and Vietnamese RAG corpora. These are engineering regression gates—not claims about every real-world document—and CI refuses changes that fall below:

| Metric | Required | Current fixture result |
| --- | ---: | ---: |
| Recall@10 | ≥ 90% | 100% |
| Citation precision | ≥ 95% | 100% |
| Refusal accuracy | ≥ 90% | 100% |

Run `npm run eval:rag` to reproduce the evaluation locally. The generation suite separately checks schema validity, grounding, instruction adherence, coverage uniqueness, provider failover, and duplicate rejection without making paid API calls.

### Bounded query planning

Retrieval planning is disabled in Lite, uses deterministic English/Vietnamese multi-query decomposition in Balanced, and enables local HyDE in Max. Lite keeps dense embeddings off, Balanced uses the lightweight `all-minilm` baseline, and Max selects the stronger multilingual [`bge-m3`](https://ollama.com/library/bge-m3) baseline. Every query and hypothetical passage is normalized and length-bounded, and the number of variants is capped before sparse or dense work begins. The service and CLI run HyDE only through the configured `retrieval.hydeModel` on the loopback Ollama endpoint; Quizzer never downloads the model automatically or selects a remote or paid generation provider for retrieval planning. If an installed local model is absent, empty, slow, or fails, retrieval records the fallback and safely continues with sparse or deterministic multi-query search. Configure the components through Advanced settings, environment variables, JSONC, or `quizzer config set`.

All variant rankings are fused by stable source-span ID before reranking and maximal-marginal-relevance diversity. Quizzer then applies the requested result and token limits once and expands parent/neighbor context only for the selected spans. Retrieval preview and `quizzer retrieve` expose the selected planning mode, bounded variants, and any safe fallback.

## Build from source

Building from source is the supported path until the first beta is available.

### Requirements

- Node.js 20 or newer
- npm
- At least one configured generation provider (a local Ollama model, signed-in agent, or API key)

Marker, image OCR, and the local semantic duplicate filter are optional and installable from Quizzer. None is required for the basic document and quiz flow.

### Quick start

```sh
git clone https://github.com/Somethings1/quizzer.git
cd quizzer
npm ci
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`.

`npm run dev` starts both the browser development server and the loopback generation service. The service listens on `127.0.0.1:8787` by default. `npm run dev:desktop` starts that same Node service beside Vite and connects Electron to it, avoiding native-addon ABI changes in the source workspace.

### Source CLI

The same SQLite library and typed settings registry are available through the development CLI:

```sh
npm run cli -- doctor
npm run cli -- config list
npm run cli -- documents import ./notes.pdf --tags infrastructure,terraform
npm run cli -- index --all --idempotency-key first-library-index
npm run cli -- test create --document DOCUMENT_ID --questions 20 --instruction "Terraform coding questions only"
npm run cli -- jobs list
npm run cli -- resume JOB_ID --provider claude-agent
npm run cli -- backup create
```

Run `npm run cli -- help` for the complete command list. Document indexing creates the same durable, per-document checkpoints used by the desktop service; `quizzer jobs list` shows both indexing and generation work, and `quizzer resume JOB_ID` finishes only an interrupted job's remaining documents. Add `--provider` and optional `--model` to select a replacement generation route without changing its saved question plan, learning instruction, prompts, or RAG settings. Usage-based API routes require `--approve-paid` for both creation and resumption, making the possible charge and provider data handling an explicit CLI action. Reusing an indexing idempotency key safely returns the original job, while `--force` explicitly rebuilds unchanged documents. Configuration is resolved in this order: per-job override, CLI/environment override, user JSONC, hardware profile, then built-in defaults. `quizzer config path` prints the per-user configuration location. API keys and the private service token are never included in settings output or backups.

Release builders use Node.js 26 or newer for `npm run build:cli`. The resulting single executable embeds the CLI, local service resources, and the platform-native SQLite addon; end users do not install Node.js.

External plugins use the versioned [`quizzer.plugin.json`](plugin-sdk/quizzer.plugin.schema.json) contract. Quizzer verifies every declared file hash and any Ed25519 signature before an atomic install, then runs plugin JSON-RPC out of process with a scoped temporary directory, bounded output, timeout/cancellation, a minimal environment, and only explicitly granted secrets. Runtime health checks report duration and sampled peak working memory in the UI, CLI JSON, and local API; cancellation escalates to forced termination if a plugin ignores the graceful signal. Signed plugins require a trusted registry key. Unsigned local plugins stay blocked unless you deliberately enable Advanced Developer Mode:

```sh
npm run cli -- config set plugins.developerMode true
npm run cli -- plugins install ./my-plugin
npm run cli -- plugins health dev.example.my-plugin
```

Developer Mode keeps an unsigned-plugin warning on each installed plugin. Turning it off blocks those plugins again. Updates retain a rollback copy; removals are moved into recoverable plugin storage rather than erased immediately.

Extractor plugins declare the `extractor` capability plus `scoped-temp` and `document-read` permissions, then implement `document.extract`. Quizzer copies one source into the invocation’s private temporary directory and supplies `{ "document": { "path", "name", "mimeType", "size" } }`. The plugin returns bounded extracted text, optional page count/parser detail, and up to 30 PNG, JPEG, or WebP images as base64. Quizzer validates the entire envelope, records `plugin:<id>@<version>` provenance, moves accepted images into content-addressed storage, and deletes the temporary source after the process exits. Select the component with `extraction.extractorPlugin` or under **Plugins & models**.

OCR plugins declare the `ocr` capability with the same file permissions and implement `document.ocr`. Each invocation receives one bounded image reference and returns `{ "text": "recognized labels" }`. Set `extraction.ocrPlugin` to the installed plugin ID and enable `extraction.ocr`; OCR text is attached to the extracted image before it can enter retrieval or a provider prompt. Cancellation, malformed output, unavailable components, and size violations stop that extraction without replacing the last durable document revision.

Reranker plugins declare the `reranker` capability and implement `rag.rerank`. Quizzer supplies the query plus bounded candidate text and stable source-span IDs; the plugin returns `{ "ranking": [{ "sourceSpanId": "…", "score": 0.9 }] }`. Set `retrieval.rerankerPlugin` to the installed plugin ID. Missing, disabled, incompatible, timed-out, or malformed rerankers fall back to Quizzer's local rank/lexical/dense signals, followed by maximal-marginal-relevance diversity selection.

Generator plugins declare the `generator` capability and implement `generation.generate`. Select the installed plugin under **Plugins & models**; Quizzer then treats its plugin ID as the local route's model. Each invocation receives the bounded prompt and output schema plus image references under `params`, and receives source images only as short-lived, read-only-by-convention files inside its scoped temporary directory. The plugin returns `{ "output": "<quiz JSON>" }`. Quizzer validates that JSON through the same schema, grounding, instruction, duplicate, and coverage gates used for every other provider, removes the temporary files after the process exits, and can fail over from an unavailable plugin without discarding accepted questions.

Embedder plugins declare the `embedder` capability and implement `rag.embed`. Quizzer sends at most 250 bounded strings plus the configured model name and expects `{ "embeddings": [[0.1, 0.2]] }` with one finite, consistently sized vector per input. The dense-index identity includes the plugin ID and installed version, so upgrading or switching an embedder builds a separate, safely rebuildable LanceDB table instead of mixing incompatible vectors. Select the component under **Plugins & models**; sparse BM25 retrieval remains available if the plugin is missing or fails.

Vector-index plugins declare the `vector-index` capability plus `scoped-temp` and `persistent-data` permissions. Quizzer supplies host-produced vectors and stable source metadata through a bounded temporary JSON file, never an original document path, and exposes a private per-plugin data directory only after that permission is declared. Advanced mode can switch between built-in LanceDB and an installed vector index; the change requires reindexing. Plugin failures leave sparse BM25 usable and the indexing job resumable, while matches are checked against authoritative sparse spans so stale or deleted plugin rows cannot appear in results. Derived plugin index data is retained through update, rollback, and recoverable plugin removal.

### Tailscale access

On macOS, double-click `start-tailscale.command` in Finder. On Windows, double-click `start-tailscale.cmd`. The cross-platform launcher detects the active Tailscale address, installs npm dependencies when needed, and prints the private URL to open from another device on the same tailnet. Keep its window open while using Quizzer and press Control-C to stop it.

The same launcher is available from a terminal as `npm run tailscale`. It binds Vite to the Tailscale interface rather than exposing Quizzer on every LAN interface.

The launcher creates or reuses a private service token in Quizzer's application-data directory and supplies it to the loopback service and Vite's server-side API proxy. The proxy adds the bearer credential to `/api` requests, replacing any browser-supplied credential, without placing the token in the renderer bundle or launcher output. The service remains bound to `127.0.0.1`; only Vite is reachable over the tailnet.

## Provider setup

Open **Plugins & models** at the bottom of the sidebar. This panel is the central place to:

- install and check Marker;
- install and connect supported CLI agents;
- enter keys for Gemini, Anthropic Claude, OpenAI, OpenRouter, or DeepSeek;
- install Ollama, explicitly choose any local generation-model download, and optionally install the lightweight `all-minilm` semantic filter;
- save the default provider and model for each provider.

The Create Test dialog starts with those defaults and lets you choose a different provider or model for an individual test.

### Ollama local generation

Choose an already installed Ollama model or enter a model name under **Plugins & models → Local generation**. Quizzer asks for confirmation before installing Ollama or downloading a model, shows live pull progress, and never chooses a model download automatically. Local requests go only to Ollama's loopback service, use JSON Schema structured output with deterministic temperature, and can include up to six bounded source images for a compatible vision model. If the runtime stops or the selected model is unavailable, the durable job pauses with its accepted questions intact so another approved route can continue only the unfinished slots.

The source CLI uses the same route with `quizzer test create ... --provider ollama --model qwen3:4b`. The model is required and must already be installed; the CLI never downloads one implicitly.

### llama.cpp local generation

Quizzer can connect to a llama.cpp server through its OpenAI-compatible `/v1` endpoint. Configure **Plugins & models → Local generation → llama.cpp local model** with a loopback endpoint such as `http://127.0.0.1:8080/v1` and the model identifier served by that process, then explicitly save the configuration. In Advanced mode, **Managed llama.cpp runtime** can validate and remember absolute paths to an already-installed `llama-server` executable and GGUF model, launch that process with hardware-bounded settings after explicit confirmation, monitor its health, and stop it cleanly. Quizzer does not download llama.cpp or model files automatically, accepts no remote endpoint for this provider, and keeps the route local, non-billable, bounded, cancellable, and resumable. The CLI supports manual endpoint mode with `quizzer test create --provider llama-cpp --model <served-model> --endpoint http://127.0.0.1:8080/v1`.

### Codex Agent

Install the Codex CLI once, then select **Connect Codex** in **Plugins & models**. Quizzer starts the Codex device sign-in flow and displays its sign-in link and instructions in the popup. Quizzer invokes Codex ephemerally, uses a read-only sandbox, and supplies a JSON Schema for the final response. Leaving the model field blank uses the Codex default.

### Gemini API

Enter the Gemini API key and default model in **Plugins & models**. Keys are session-only by default. In the desktop app, **Remember on this device** stores a key only after explicit confirmation using Electron's OS-backed encryption; Linux remembering remains unavailable when no secure keyring is present. No environment variable or terminal configuration is required.

### Claude and Antigravity agents

Select **Install Claude** or **Install Antigravity** if its CLI is missing, then select **Connect** and finish the provider's browser sign-in. Quizzer uses each CLI's documented non-interactive JSON Schema mode and disables or sandboxes agent tool access during quiz generation.

### API providers

Gemini, Anthropic Claude, OpenAI, OpenRouter, and DeepSeek are configured the same way: enter a key and default model under **Plugins & models**, choose session-only or explicitly remember it in the desktop vault, then select that provider while creating a test. DeepSeek uses JSON mode plus Quizzer's runtime validation; the other adapters request schema-constrained output where supported.

End users do not configure providers in a terminal. Provider installation, account connections, model selection, API credentials, quiz settings, and theme selection all live in the application UI.

### Custom OpenAI-compatible generation

Quizzer supports any OpenAI-compatible chat completions endpoint (such as self-hosted models, vLLM, Ollama, LM Studio, or custom gateways) under **Plugins & models → API providers → OpenAI-compatible – Custom**.

- **Base endpoint validation:** The base endpoint is centrally validated. Remote endpoints must use HTTPS; unencrypted HTTP is allowed strictly for numeric loopback hosts (`127.0.0.0/8` and `[::1]`). The llama.cpp route rejects hostname aliases such as `localhost` so its local-only privacy guarantee does not depend on DNS resolution. Userinfo credentials, query parameters, URL fragments, path traversal (`..`), redundant separators (`//`), encoded separators (`%2f`, `%5c`), backslashes, and null bytes are rejected. HTTP redirects are treated as configuration errors and rejected.
- **Configuration precedence:** The non-secret base endpoint resolves with strict precedence: CLI flag (`--endpoint` or `--base-endpoint`) > environment variable (`QUIZZER_OPENAI_COMPATIBLE_ENDPOINT`, `QUIZZER_OPENAI_COMPATIBLE_BASE_URL`, or `QUIZZER_OPENAI_COMPATIBLE_BASE_ENDPOINT`) > user settings JSONC (`providers.openai-compatible.endpoint`) > built-in default (`https://api.openai.com/v1`).
- **Explicit model requirement:** OpenAI-compatible routes require an explicit model name; there is no implicit fallback model.
- **Credentials protection:** Credentials use only the existing credential store (or `QUIZZER_OPENAI_COMPATIBLE_API_KEY` in environment / UI session or OS keychain) and never appear in settings files, logs, exports, or diagnostics. For loopback endpoints, API keys are optional.
- **Policy and privacy:** The provider is classified with `billing: 'usage-based'`, `privacy: 'remote-api'`, and `defaultConcurrency: 2`. Using this route requires the same explicit approval gate (`--approve-paid` on CLI, or approval checkbox in UI) as other remote API routes.
- **Bounded requests and durable failover:** Requests are bounded (up to 2,000,000 character prompt, 100 KB schema, 6 images / 20 MB total) and responses are capped at 16 MB. Requests use structured JSON mode (`response_format: { type: 'json_object' }`), timeout enforcement, and cancellation propagation. Failures map into durable failover states: authentication errors (401/403) to `provider_auth`, rate limits and quota exhaustion (402/429) to `provider_limit`, and connectivity/malformed output to `provider_unavailable`.

CLI usage:
```bash
quizzer test create "quiz-name" --document doc.pdf --provider openai-compatible --model custom-model-name --approve-paid [--endpoint https://api.example.com/v1]
```

## PDF conversion

Quizzer offers two upload modes:

- **Automatic:** uses the configured extractor plugin, or attempts Marker and falls back to browser-based PDF/text extraction when the built-in component is selected.
- **Basic:** uses PDF.js text extraction only.

Select **Install Marker** in **Plugins & models** for better preservation of document structure. Quizzer creates a private Python environment under `.quizzer-tools/marker` and downloads Marker there. Installation can take several minutes and requires an internet connection and substantial disk space.

Marker itself does not impose Quizzer's former 30-image limit. Quizzer now stores every image Marker returns, together with its page, caption, nearby source text, and Markdown position when available. For each AI request, it ranks those stored images against the selected source chunks and sends at most six relevant images to keep requests bounded.

Select **Install Image OCR** separately to create a private RapidOCR environment under `.quizzer-tools/ocr`. OCR is opt-in: when installed and enabled, new Marker extractions read text from figures, diagrams, and screenshots. Text-only providers receive the resulting descriptions, while supported multimodal providers receive both those descriptions and the selected image data. The document view exposes extracted images and their OCR text for review.

Installed tools and configured providers have independent **Enabled** toggles. Turning one off keeps its installation or credentials intact but removes providers from pickers and prevents Marker, OCR, or semantic embeddings from being used until re-enabled.

Scanned or visually complex documents can still require manual review. Always inspect extracted content before generating a high-stakes quiz.

## Creating a quiz

1. Open the **Documents** sidebar tab.
2. Select **Add documents**, choose files, and optionally assign comma-separated tags.
3. Inspect a document's extracted content from the main view.
4. Open the **Tests** tab and select **Create test**.
5. Filter and select documents by name or tag.
6. Choose one combined quiz or one separate quiz per document.
7. Choose how many multiple-choice, fill-in-the-blank, reasoning, and coding questions to create.
8. For multiple-choice questions, require either exactly one or multiple correct answers.
9. For a combined test, choose balanced, proportional, AI-selected, or cross-document coverage.
10. Select a provider and optional provider-specific model.
11. Review every primary and automatic-failover route, then explicitly approve sending the selected excerpts and images. Usage-based routes are labeled before approval.
12. Queue generation and continue using Quizzer.

If a requested test name already exists, Quizzer keeps both tests by adding a numeric postfix such as `(2)` or `(3)`.

The creation dialog closes immediately after saving the job. The local service assigns each worker to a different test and makes one provider request at a time. Within that test, each question type is generated sequentially using the resolved batch-size snapshot. Each later prompt excludes everything accepted from earlier batches. Other workers process other tests rather than generating overlapping candidates for the same test. Closing or reloading the window does not interrupt generation; in the desktop app, closing the window hides Quizzer in the tray while the service continues and the tray reports active and running job counts. Set **Continue in background** off in Settings when closing the last window should quit instead. If the local service is temporarily unreachable, Quizzer conservatively stays in the tray rather than risking an interrupted job.

Quizzer never concatenates every selected document into a generation prompt. Uploads are split into lightweight page-aware chunk boundaries, and older documents are chunked lazily the first time they are used. A persisted coverage plan assigns document chunks to every requested question. Each provider request receives at most approximately 54,000 source characters, the relevant assignment list, and up to six source images. Retry and refill rounds reuse the same unfilled coverage slots.

- **Balanced** guarantees one slot per document when the question count permits, then distributes additional slots evenly.
- **Proportional** first covers every document when possible, then gives documents with more chunks additional slots.
- **AI-selected** uses the local embedding plugin to prioritize material closest to the collection's semantic center, with a size-based fallback when embeddings are unavailable.
- **Cross-document** assigns material from two or three documents to each slot for comparison and synthesis questions.

If the requested question count is smaller than the number of documents, the creation dialog warns that complete coverage is impossible instead of silently implying otherwise.

Open **Activity** to choose between 1 and 10 concurrent test instances; the default is 5. Lower values reduce simultaneous provider usage and memory pressure. Higher values complete multi-document queues faster. Reducing the value does not abort requests already running—the new limit takes effect as they finish.

The same panel controls batch size from 5 to 25 questions, defaulting to 20. Larger batches reduce request overhead, while smaller batches create more frequent recovery checkpoints and reduce the amount of work lost when a provider returns malformed output. Refill requests always ask for the exact remaining count when it is smaller than the configured batch size.

Every candidate is independently validated and deduplicated before the next batch begins. The local service independently revalidates modern checkpoint schemas, per-type targets, and stable source provenance before committing them, so a stale or compromised renderer cannot bypass the protected output contract. The quality gate also rejects lesson-bound trivia—such as slide structure, classroom instructions, demo setup, and components installed only for an exercise—so generated questions favor durable conceptual, diagnostic, and applied knowledge. Multiple-choice candidates must use credible near-miss distractors from the same domain, sufficiently useful explanations, and choices balanced in grammar, specificity, and approximate length; conspicuous length outliers are rejected and refilled. Rejected candidates leave only their missing slots for the next bounded refill round. If a target cannot be reached after five rounds, Quizzer saves the valid partial quiz instead of retrying forever.

Open **Activity** from the sidebar or the floating activity indicator to inspect generation and document-indexing jobs, see their durable checkpoints, cancel work, resume remaining documents, retry an error, or switch providers. As each separate test completes it appears in the Tests sidebar immediately, where you can take it while later jobs continue.

New generation jobs enter through a dedicated service API that validates the complete RAG/settings snapshot, question targets, provider routes, and truthful privacy/cost metadata before committing the entire batch transactionally. Desktop and CLI creation both snapshot every resolved typed setting, including profile, user, environment, and command-line overrides; the stored RAG profile must agree with that snapshot, so later configuration changes cannot alter an in-progress job. Generic browser synchronization can import jobs only during the verified legacy bootstrap and cannot forge job state afterward. Creation retries are idempotent by job ID, and only completed or cancelled jobs can be dismissed through synchronization.

After every request and validated round, Quizzer checkpoints progress, accepted questions, retry counters, rejection reasons, and provider settings through the local service. The service owns generation, retrieval, provider calls, and lease renewal, so renderer crashes and page reloads cannot stop active work. It accepts updates only from the worker holding the renewable 45-second lease, preventing an expired worker from overwriting a resumed job. It also validates coverage plans, progress counters, append-only quality and provider-attempt history, and route changes against the immutable creation snapshot. Low-confidence evidence gets one corrective retrieval pass and then a clear refusal; schema-valid but ungrounded, instruction-mismatched, duplicate, or out-of-coverage candidates are audited and only their unfinished slots are refilled. A job cannot be marked complete until every requested slot passes these gates. Creating the final test and completing its job is one idempotent SQLite transaction. Remembered API credentials are decrypted by the desktop and handed directly to service memory after every service start; session credentials use the authenticated loopback channel. Values never enter jobs, settings, logs, backups, or diagnostics, and only configured provider names can be queried. A dropped provider connection moves the job into a waiting state and retries automatically; quota and authentication failures preserve accepted questions and pause only when no pre-approved route remains.

The global generation concurrency setting is additionally bounded by a separate cap for each provider. These provider caps live in the typed settings registry and are enforced transactionally by the local service across all connected Quizzer windows; a saturated route no longer blocks eligible work queued for another provider. Agent routes default to one active process, while API routes use conservative, editable limits.

If a provider runs out of quota, loses authentication, or becomes unavailable, generation pauses and offers another provider. Already accepted questions remain in memory, the replacement provider requests only the missing slots, and duplicate detection compares its output against the full accepted set. Switching providers does not consume a validation retry round.

Fill-in-the-blank generation explicitly explores canonical terms, abbreviations, symbols, conjunctions, and concise equivalent wording. Grading ignores capitalization, punctuation, and repeated spaces; it also recognizes omitted repeated qualifiers in compound answers, so `id+version` can match `document_id + document_version` while still requiring both concepts. Coding questions ask for a practical solution based on the source and include an example implementation plus correctness criteria. In test mode, reasoning and coding references stay hidden until review and answers are graded by the configured LLM in sequential batches of at most 10. In practice mode, the learner reveals the reference answer, compares the essential points, and records a self-assessment.

Before starting a saved test, choose **Test mode** for the traditional submit-then-review flow or **Practice mode** for immediate feedback. Practice mode locks each submitted response, shows correctness and every multiple-choice explanation or accepted fill-in answer, and lets the learner move among unanswered questions freely. Select **Check answer** or press Enter; in a reasoning or coding response, use Shift+Enter for a new line. After checking an answer, press `?` to open its Ask AI chat.

Ask AI uses retrieval-augmented generation rather than placing the whole library into the prompt. Document chats retrieve only from that document. Practice chats use the test's stored document IDs as a hard metadata filter, rank matching chunks inside that scope, and send at most eight passages and four associated images. Cancelling or closing a request propagates through remote generation, local embeddings, Marker extraction, OCR, and external reranker processes; a cancelled dense query is never misreported as a broken model. Durable document indexing is allowed to finish its current checkpoint so another request can reuse it. The learner's message appears immediately while an animated agent avatar shows request progress. Responses render GitHub-flavored Markdown with compact inline `[1]` citations. Hover or keyboard-focus a citation to inspect it: slide-like PDFs show the original rendered slide, while textbook-like PDFs and other documents show the retrieved text chunk. Existing PDFs can locate the cited page from the excerpt; new Marker conversions preserve explicit page boundaries.

Quizzer continuously saves the active test or practice session locally and to SQLite, including the current question, answers, review marks, revealed feedback, self-assessments, shuffled choice order, mode, and timer start. In practice mode, **Pause** freezes the timer, syncs immediately, and exposes **Resume Practice** on every connected machine. If the connection drops or the page closes, reopening Quizzer restores the latest unfinished session. Submitting the attempt removes its saved draft on every synchronized device.

## Server database and IndexedDB migration

Quizzer stores authoritative metadata, extracted text, tests, attempts, generation and indexing jobs, and unfinished sessions in `data/quizzer.sqlite` under the native application-data directory. Indexing checkpoints after each document, automatically recovers a `running` job when the service restarts, and never repeats already committed documents. Original uploaded files and extracted figures are verified by SHA-256 and deduplicated in `objects/sha256`; SQLite stores only immutable references to them. Rebuildable FTS5/BM25 data lives separately in `indexes/sparse.sqlite`; Balanced and Max profiles can add model-versioned LanceDB vectors under `indexes/dense.lance`. Neither derived index is confused with source data or copied into backups. If Ollama or the configured embedding model is unavailable, the durable job remains resumable and retrieval clearly falls back to sparse evidence. Unreferenced uploads are retained for 24 hours to protect in-flight sync, then reclaimed during periodic service cleanup. SQLite write-ahead logging protects concurrent browser writes, while an ordered change log propagates updates and deletions between machines.

Each document records its extraction schema, converter version, extraction time, and extracted-content hash. **Re-extract original** (or `quizzer documents reextract <id>`) reads the SHA-256-verified original from object storage, retains up to 20 prior extraction revisions, invalidates stale derived metadata, and rebuilds retrieval through a durable indexing job.

To migrate the existing Zen Browser library, start this updated version and open Quizzer once in the same Zen profile and at the exact same URL previously used. IndexedDB is isolated by browser profile and URL origin, so this one visit is required for the page to read the old `QuizDB` database. Before accepting the first batch, the service creates and hashes a timestamped SQLite backup under the application-data `backups/migrations` directory. Each imported record is receipted with SHA-256 in the same transaction as its batch; Quizzer verifies the final record count, aggregate hash, and SQLite presence before the browser marks the import complete. The sidebar then changes from **Syncing library** to **Saved on server**. You can open the same Quizzer URL from another machine after that; it downloads the server library automatically.

The initial import merges records by ID in bounded batches and runs behind the usable interface. Existing server records win an initial-import conflict, preventing an old browser cache from replacing a newer shared copy. Later edits are ordered by the server and synchronized every five seconds, when the tab becomes visible, and immediately after reconnecting. While offline, the sidebar shows **Offline — saved locally** and pending mutations remain in IndexedDB. Select the sync row to see preparation, batch and byte-transfer progress, local application, the pending-change count, the latest successful sync time, or the connection error.

When a schema-v1 database still contains the old embedded retrieval tables, Quizzer creates a timestamped SQLite backup and matching SHA-256 checksum under `backups/schema` before removing those rebuildable tables. Source records remain in the authoritative database; retrieval rebuilds in the separate index database on demand.

Use `quizzer migrations list` to inspect IndexedDB migration status, hashes, and retained rollback paths. Use `quizzer backup create` for a consistent live backup of SQLite, configuration, and every content-addressed original; `quizzer backup verify <directory>` re-hashes every entry before you rely on it. After quitting the desktop app and local service, `quizzer backup restore <directory> --yes` verifies the backup again, preserves the current library as a recovery backup, and atomically replaces the database, object store, and safe configuration while clearing derived indexes for rebuild. Quizzer uses the native per-user application-data directory by default; set `QUIZZER_APP_DATA_DIR`, `QUIZZER_DATABASE_PATH`, `QUIZZER_SPARSE_INDEX_PATH`, or `QUIZZER_DENSE_INDEX_PATH` when custom locations are needed for a packaged or managed deployment.

Authenticated desktop and remote clients can create the same complete backup with `POST /api/v1/backups`, list service-managed backups with `GET /api/v1/backups`, and perform a full integrity verification with `GET /api/v1/backups/{backupId}`. Restore remains an offline CLI operation so the active service cannot replace its own database.

Under **Plugins & models**, Quizzer shows the embedding model resolved for the active hardware profile and asks for explicit confirmation before installing Ollama or downloading that model. Balanced downloads `all-minilm`; Max warns that its multilingual `bge-m3` download is approximately 1.2 GB. The service accepts only the currently resolved model, so a profile change requires a fresh confirmation. If the local runtime or model is unavailable, generation continues with normalized exact matching, lexical similarity, and size-based source prioritization while retrieval falls back to sparse evidence.

## Data and privacy

- Document metadata, extracted text, quizzes, attempts, generation checkpoints, and unfinished sessions are stored in server-side SQLite. Original uploaded files and extracted figures live in the content-addressed object store outside the database.
- Each browser keeps a synchronized IndexedDB cache named `QuizDB` for responsive UI and offline recovery.
- New `Blob` and `File` values are uploaded through the authenticated object API and verified against their SHA-256 address before their reference is synchronized. Legacy base64 records are materialized into the same object store before SQLite accepts them.
- Agent requests use the selected locally authenticated CLI.
- API requests send selected extracted content—and figures for supported multimodal models—to the selected provider.
- API keys pass through the loopback service only for the active request. They remain in browser session storage unless the desktop user explicitly remembers them in the OS-protected credential vault; they are never written to IndexedDB, local storage, settings exports, backups, or diagnostics.
- Deleting browser site data clears only that browser's cache; reopening Quizzer repopulates it from the server.
- Deleting Quizzer's application-data directory deletes the shared server library. Keep backups of important data.

Do not upload confidential material unless the selected provider and your account's data-handling terms are appropriate for it.

## CLI and development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local service and Vite development server |
| `npm run tailscale` | Start Quizzer on this machine's Tailscale address |
| `npm run dev:web` | Start only Vite; generation endpoints must be provided separately |
| `npm run service` | Start only the loopback generation service |
| `npm run cli -- help` | Run the source CLI for configuration, documents, jobs, and backups |
| `npm run build` | Type-check and create the production browser bundle |
| `npm run package:desktop` | Build an unpacked desktop application for the current platform |
| `npm run make:desktop` | Build the current platform's configured installer/archive |
| `npm run verify:desktop-fuses` | Verify every configured fuse in the current packaged desktop executable |
| `npm run build:cli` | Build the standalone CLI with Node.js 26+ |
| `npm run lint` | Run ESLint |
| `npm test` | Run unit and service integration tests |
| `npm run test:e2e` | Run the isolated Chromium onboarding and mocked-generation workflow |
| `npm run test:e2e:electron` | Rebuild SQLite for Electron, package the current-platform app with production fuses, and smoke-test the packaged sandboxed shell |
| `npm run test:coverage` | Enforce 90% line and 80% branch coverage across core service modules |
| `npm run eval:rag` | Run the offline English/Vietnamese retrieval quality gate |
| `npm run license:check` | Verify application and landing dependency licenses against the release policy |
| `npm run preview` | Preview the browser bundle; start the service separately for generation |

The application E2E harness creates and removes a fresh temporary service database for every run; it never opens the development library. Run `cd landing && npm run test:e2e` for the separate Chromium landing-page gate. It verifies platform-specific installers, clipboard actions, signed-manifest trust and fallback, the client-only demo, mobile overflow, keyboard controls, and social metadata. CI installs both isolated browser runtimes automatically.

Source development uses loopback port 8787 so Vite can proxy API requests. The packaged desktop app asks the operating system for an unused ephemeral loopback port, waits for an authenticated utility-process ready message, and only then opens the renderer; set `QUIZZER_DESKTOP_SERVICE_PORT` only for a managed desktop deployment that requires a fixed port.

## Troubleshooting

### Quizzer asks for an API key

Enter the provider's key in **Plugins & models → API providers**. Leave **Remember on this device** off for session-only use, or enable it in the desktop app to use OS-protected storage after confirmation.

### `spawn codex ENOENT`

Install Codex CLI and ensure `codex` is available on `PATH` for the process starting Quizzer. Authentication itself can then be completed from **Plugins & models**.

### An agent reaches its usage limit

Open **Activity**, select a configured replacement provider on the paused job, and choose **Continue**. Accepted questions are preserved. If the replacement uses an API key you have not entered, open **Plugins & models** directly from the job first.

From the CLI, use `quizzer resume JOB_ID --provider claude-agent`, or select a usage-based route with `quizzer resume JOB_ID --provider openai --model gpt-5-mini --approve-paid`. The route choice is appended to the job audit history and only unfinished questions are generated.

### Generation was interrupted

Keep or reopen Quizzer on the same browser origin. Network failures retry automatically after connectivity returns. Jobs that were active when the page closed are requeued from their latest verified batch when the application opens again. A restored job pauses for authentication when its route used a session-only key that has expired.

### Semantic filtering is not active

Open **Plugins & models** and install the semantic duplicate filter. If installation fails, review the live installer output. Quiz generation still uses exact and lexical duplicate checks without it.

### Marker is not used

Open **Plugins & models** and select **Install Marker**. The popup shows live installation progress and any error. Until Marker is ready, Automatic mode silently uses basic extraction.

### Images have no searchable text

Open **Plugins & models**, install **Image OCR**, and leave its **Enabled** toggle on before uploading the document. OCR is applied during new Marker extractions; existing documents keep their previously extracted image metadata.

### A quiz contains fewer questions than requested

The generation pipeline reached its bounded retry limit after rejecting malformed or duplicate candidates. The accepted questions are retained. Try filling the missing concepts again or reduce the requested count for a small source document.

## Project documentation

- [OpenAPI v1 contract](openapi/quizzer-v1.yaml) — authenticated settings, onboarding, plugins, documents, retrieval, jobs, backups, and progress APIs.
- [Plugin SDK](plugin-sdk/README.md) — manifest format, capabilities, permissions, lifecycle, and JSON-RPC runtime.
- [Signed plugin registry](docs/plugin-registry.md) — registry trust model, installation, updates, and rollback.
- [Release manifest schema](release/release-manifest.schema.json) — canonical signed artifact metadata consumed by installers, updates, and the landing page.
- [Maintainer release guide](RELEASING.md) — build matrix, signing configuration, validation, and publication procedure.

## Development notes

- Provider-specific behavior belongs in the local service; the UI works with Quizzer's internal generation contract.
- Do not assume third-party CLIs share command flags or output events. Add an adapter per provider.
- New quiz fields require both TypeScript types and runtime validation.
- Database schema changes require a new Dexie version and a migration strategy.
- Duplicate thresholds should be evaluated against representative quiz sets before changing defaults.

## Contributing and support

Bug reports, feature proposals, and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before making a change and follow the [Code of Conduct](CODE_OF_CONDUCT.md) when participating.

- Use [GitHub Issues](https://github.com/Somethings1/quizzer/issues) for reproducible bugs and scoped feature requests.
- Use [GitHub Discussions](https://github.com/Somethings1/quizzer/discussions) for questions and broader product ideas.
- Use GitHub's private vulnerability reporting flow for security issues; never post credentials, private documents, or exploit details in a public issue.

## Security

Please do not publish suspected vulnerabilities in a public issue. Follow the private reporting instructions and supported-version policy in [SECURITY.md](SECURITY.md). The local service binds to loopback only, authenticates privileged endpoints, and treats provider inputs as untrusted, but the project has not yet undergone an independent security review.

## License

Quizzer is licensed under the [Apache License 2.0](LICENSE). Distribution must retain the included [NOTICE](NOTICE). Third-party dependencies, optional tools such as Marker, and downloaded model weights remain subject to their own license terms; release builds publish a dependency SBOM.
