# Quizzer

Quizzer is a local-first study application that turns a reusable document library into validated mixed-format quizzes. Documents are uploaded and extracted once, tagged for later discovery, and then selected whenever you want to create either separate quizzes or one combined quiz.

> **Project status:** active development. Local data and the generation pipeline are usable, but this project has not yet published a stable release or completed a security audit.

The Quizzer 1.0 foundation now includes a resumable first-run walkthrough, Simple and Advanced creation modes, hardware-aware Lite/Balanced/Max recommendations, per-test learning instructions, source-span provenance, and a separately deployable product site. Existing libraries bypass forced onboarding and receive a dismissible upgrade summary instead.

Production installers remain a release gate: their stable URLs become active only after CI has produced, signed, notarized, and published every artifact in the versioned [release manifest schema](release/release-manifest.schema.json). Until then, download actions fall back to GitHub Releases rather than guessing an artifact URL.

## Install Quizzer

After a validated release is published, macOS and Linux users can install the desktop app and standalone CLI per-user with:

```sh
curl -fsSL https://github.com/Somethings1/quizzer/releases/latest/download/install.sh | sh
```

On Windows, run this in PowerShell:

```powershell
irm https://github.com/Somethings1/quizzer/releases/latest/download/install.ps1 | iex
```

These installers do not require Node.js, Python, or Git. They select the current x64 or arm64 artifacts, verify the canonical Ed25519 release metadata and SHA-256 checksum, require the platform signature on macOS and Windows, install `quizzer` on the user PATH, register the desktop application, and launch onboarding. Existing application directories are retained with a timestamped `.previous-*` name on Unix-like systems for rollback.

## Screenshots

| Document library | Quiz creation |
| --- | --- |
| ![Document library with searchable tags and extracted content](docs/screenshots/document-library-light.jpg) | ![Dark-mode quiz creation from selected documents](docs/screenshots/quiz-creation-dark.jpg) |

| Mobile quiz | Mobile results |
| --- | --- |
| ![Responsive quiz-taking interface on mobile](docs/screenshots/mobile-quiz-dark.jpg) | ![Responsive test summary on mobile](docs/screenshots/mobile-summary-dark.jpg) |

## Features

- Local document library with PDF, Markdown, and text uploads
- Visible extraction progress with per-file retry on failure
- Responsive mobile navigation and quiz layouts
- Persistent light and dark themes
- Tags and tag-aware document search
- Extracted-content viewer
- Separate quiz generation for each selected document
- Combined quiz generation across selected documents
- Configurable question count and provider model override
- Configurable mix of multiple-choice, fill-in-the-blank, reasoning, and coding questions
- Single-answer or multiple-correct-answer generation for multiple-choice questions
- Fill-in-the-blank grading across generated variants, shorthand, symbols, and omitted repeated qualifiers
- Learner self-assessment against reference answers for reasoning and coding questions
- Practice mode with immediate per-question answers and explanations
- Automatic recovery of unfinished test and practice sessions
- In-app Plugins & models panel for setup and defaults
- Codex, Claude Code, and Antigravity agent integrations using existing CLI authentication
- Gemini, Anthropic Claude, OpenAI, OpenRouter, and DeepSeek API integrations
- Structured provider output and runtime question validation
- Live generation progress by test, question type, and retry round
- Persistent background generation queue, usable while you take completed tests
- Configurable 1–10 concurrent test instances
- Configurable 5–25 questions per provider request, defaulting to 20
- Mid-generation cancellation that stops all active provider processes
- Provider failover that preserves accepted questions after quota, authentication, or service failures
- Automatic recovery from reloads and network interruptions at the latest verified checkpoint
- Bounded refill attempts: valid questions survive when another candidate is rejected
- Exact and lexical near-duplicate filtering
- Optional local semantic duplicate filtering through Ollama
- Optional Marker PDF conversion with tables, equations, and extracted figures
- Optional local RapidOCR analysis for text inside extracted figures
- Fresh AI-generated practice for concepts missed on the latest attempt
- Server-side SQLite storage with an offline IndexedDB cache
- Original-file previews and document-scoped RAG chats with Markdown answers and source references

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
                  Signed-in agents            API providers
             Codex · Claude · Antigravity   Gemini · Claude · OpenAI
                                            OpenRouter · DeepSeek
                         └────────────┬────────────┘
                                      ▼
                         validate + reject duplicates
                                      ▼
                              saved local quiz
```

The React application never starts shell commands directly. It calls a loopback-only Node service, which invokes provider adapters, owns the SQLite library, and keeps API credentials outside browser bundles. The desktop process waits for that service before opening and restarts it with capped backoff after an unexpected exit. Each browser retains an IndexedDB cache so work remains usable during a short outage and synchronizes when the server returns.

## Source development requirements

- Node.js 20 or newer
- npm
- At least one configured generation provider (a signed-in agent or an API key)

Marker, image OCR, and the local semantic duplicate filter are optional and installable from Quizzer. None is required for the basic document and quiz flow.

## Quick start

```sh
git clone https://github.com/Somethings1/quizzer.git
cd quizzer
npm ci
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`.

`npm run dev` starts both the browser development server and the loopback generation service. The service listens on `127.0.0.1:8787` by default.

### Source CLI

The same SQLite library and typed settings registry are available through the development CLI:

```sh
npm run cli -- doctor
npm run cli -- config list
npm run cli -- documents import ./notes.pdf --tags infrastructure,terraform
npm run cli -- test create --document DOCUMENT_ID --questions 20 --instruction "Terraform coding questions only"
npm run cli -- jobs list
npm run cli -- backup create
```

Run `npm run cli -- help` for the complete command list. Configuration is resolved in this order: per-job override, CLI/environment override, user JSONC, hardware profile, then built-in defaults. `quizzer config path` prints the per-user configuration location. API keys and the private service token are never included in settings output or backups.

Release builders use Node.js 26 or newer for `npm run build:cli`. The resulting signed single executable embeds the CLI, local service resources, and the platform-native SQLite addon; end users do not install Node.js.

External plugins use the versioned [`quizzer.plugin.json`](plugin-sdk/quizzer.plugin.schema.json) contract. Quizzer verifies every declared file hash and any Ed25519 signature before an atomic install, then runs plugin JSON-RPC out of process with a scoped temporary directory, bounded output, timeout/cancellation, a minimal environment, and only explicitly granted secrets. Signed plugins require a trusted registry key. Unsigned local plugins stay blocked unless you deliberately enable Advanced Developer Mode:

```sh
npm run cli -- config set plugins.developerMode true
npm run cli -- plugins install ./my-plugin
npm run cli -- plugins health dev.example.my-plugin
```

Developer Mode keeps an unsigned-plugin warning on each installed plugin. Turning it off blocks those plugins again. Updates retain a rollback copy; removals are moved into recoverable plugin storage rather than erased immediately.

### Tailscale access

On macOS, double-click `start-tailscale.command` in Finder. On Windows, double-click `start-tailscale.cmd`. The cross-platform launcher detects the active Tailscale address, installs npm dependencies when needed, and prints the private URL to open from another device on the same tailnet. Keep its window open while using Quizzer and press Control-C to stop it.

The same launcher is available from a terminal as `npm run tailscale`. It binds Vite to the Tailscale interface rather than exposing Quizzer on every LAN interface.

## Provider setup

Open **Plugins & models** at the bottom of the sidebar. This panel is the central place to:

- install and check Marker;
- install and connect supported CLI agents;
- enter keys for Gemini, Anthropic Claude, OpenAI, OpenRouter, or DeepSeek;
- install Ollama and the lightweight `all-minilm` semantic filter;
- save the default provider and model for each provider.

The Create Test dialog starts with those defaults and lets you choose a different provider or model for an individual test.

### Codex Agent

Install the Codex CLI once, then select **Connect Codex** in **Plugins & models**. Quizzer starts the Codex device sign-in flow and displays its sign-in link and instructions in the popup. Quizzer invokes Codex ephemerally, uses a read-only sandbox, and supplies a JSON Schema for the final response. Leaving the model field blank uses the Codex default.

### Gemini API

Enter the Gemini API key and default model in **Plugins & models**. Keys are session-only by default. In the desktop app, **Remember on this device** stores a key only after explicit confirmation using Electron's OS-backed encryption; Linux remembering remains unavailable when no secure keyring is present. No environment variable or terminal configuration is required.

### Claude and Antigravity agents

Select **Install Claude** or **Install Antigravity** if its CLI is missing, then select **Connect** and finish the provider's browser sign-in. Quizzer uses each CLI's documented non-interactive JSON Schema mode and disables or sandboxes agent tool access during quiz generation.

### API providers

Gemini, Anthropic Claude, OpenAI, OpenRouter, and DeepSeek are configured the same way: enter a key and default model under **Plugins & models**, choose session-only or explicitly remember it in the desktop vault, then select that provider while creating a test. DeepSeek uses JSON mode plus Quizzer's runtime validation; the other adapters request schema-constrained output where supported.

End users do not configure providers in a terminal. Provider installation, account connections, model selection, API credentials, quiz settings, and theme selection all live in the application UI.

## PDF conversion

Quizzer offers two upload modes:

- **Automatic:** attempts Marker and falls back to browser-based PDF text extraction.
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
11. Queue generation and continue using Quizzer.

If a requested test name already exists, Quizzer keeps both tests by adding a numeric postfix such as `(2)` or `(3)`.

The creation dialog closes immediately after saving the job. Each instance is assigned to a different test and makes one provider request at a time. Within that test, each question type is generated sequentially using the configured batch size. The default is 20, so 45 missing questions become requests of 20, 20, and 5; each later prompt can exclude everything accepted from earlier batches. Other instances work on other tests rather than generating overlapping candidates for the same test.

Quizzer never concatenates every selected document into a generation prompt. Uploads are split into lightweight page-aware chunk boundaries, and older documents are chunked lazily the first time they are used. A persisted coverage plan assigns document chunks to every requested question. Each provider request receives at most approximately 54,000 source characters, the relevant assignment list, and up to six source images. Retry and refill rounds reuse the same unfilled coverage slots.

- **Balanced** guarantees one slot per document when the question count permits, then distributes additional slots evenly.
- **Proportional** first covers every document when possible, then gives documents with more chunks additional slots.
- **AI-selected** uses the local embedding plugin to prioritize material closest to the collection's semantic center, with a size-based fallback when embeddings are unavailable.
- **Cross-document** assigns material from two or three documents to each slot for comparison and synthesis questions.

If the requested question count is smaller than the number of documents, the creation dialog warns that complete coverage is impossible instead of silently implying otherwise.

Open **Generation queue** to choose between 1 and 10 concurrent test instances; the default is 5. Lower values reduce simultaneous provider usage and memory pressure. Higher values complete multi-document queues faster. Reducing the value does not abort requests already running—the new limit takes effect as they finish.

The same panel controls batch size from 5 to 25 questions, defaulting to 20. Larger batches reduce request overhead, while smaller batches create more frequent recovery checkpoints and reduce the amount of work lost when a provider returns malformed output. Refill requests always ask for the exact remaining count when it is smaller than the configured batch size.

Every candidate is independently validated and deduplicated before the next batch begins. The quality gate also rejects lesson-bound trivia—such as slide structure, classroom instructions, demo setup, and components installed only for an exercise—so generated questions favor durable conceptual, diagnostic, and applied knowledge. Multiple-choice candidates must use credible near-miss distractors from the same domain, sufficiently useful explanations, and choices balanced in grammar, specificity, and approximate length; conspicuous length outliers are rejected and refilled. Rejected candidates leave only their missing slots for the next bounded refill round. If a target cannot be reached after five rounds, Quizzer saves the valid partial quiz instead of retrying forever.

Open **Generation queue** from the sidebar or the floating activity indicator to inspect every job, cancel work, retry an error, or switch providers. As each separate test completes it appears in the Tests sidebar immediately, where you can take it while later jobs continue.

After every request and validated round, Quizzer checkpoints progress, accepted questions, retry counters, and provider settings through the local service. The service accepts updates only from the renderer holding the renewable 45-second lease, preventing an expired tab from overwriting a resumed job. Creating the final test and completing its job is one idempotent SQLite transaction. A dropped connection moves the job into a waiting state and retries automatically when connectivity returns. Reloading or closing the page stops active computation; after the abandoned lease expires, any connected Quizzer window can resume from the latest checkpoint without restarting accepted batches from zero.

If a provider runs out of quota, loses authentication, or becomes unavailable, generation pauses and offers another provider. Already accepted questions remain in memory, the replacement provider requests only the missing slots, and duplicate detection compares its output against the full accepted set. Switching providers does not consume a validation retry round.

Fill-in-the-blank generation explicitly explores canonical terms, abbreviations, symbols, conjunctions, and concise equivalent wording. Grading ignores capitalization, punctuation, and repeated spaces; it also recognizes omitted repeated qualifiers in compound answers, so `id+version` can match `document_id + document_version` while still requiring both concepts. Coding questions ask for a practical solution based on the source and include an example implementation plus correctness criteria. In test mode, reasoning and coding references stay hidden until review and answers are graded by the configured LLM in sequential batches of at most 10. In practice mode, the learner reveals the reference answer, compares the essential points, and records a self-assessment.

Before starting a saved test, choose **Test mode** for the traditional submit-then-review flow or **Practice mode** for immediate feedback. Practice mode locks each submitted response, shows correctness and every multiple-choice explanation or accepted fill-in answer, and lets the learner move among unanswered questions freely. Select **Check answer** or press Enter; in a reasoning or coding response, use Shift+Enter for a new line. After checking an answer, press `?` to open its Ask AI chat.

Ask AI uses retrieval-augmented generation rather than placing the whole library into the prompt. Document chats retrieve only from that document. Practice chats use the test's stored document IDs as a hard metadata filter, rank matching chunks inside that scope, and send at most eight passages and four associated images. The learner's message appears immediately while an animated agent avatar shows request progress. Responses render GitHub-flavored Markdown with compact inline `[1]` citations. Hover or keyboard-focus a citation to inspect it: slide-like PDFs show the original rendered slide, while textbook-like PDFs and other documents show the retrieved text chunk. Existing PDFs can locate the cited page from the excerpt; new Marker conversions preserve explicit page boundaries.

Quizzer continuously saves the active test or practice session locally and to SQLite, including the current question, answers, review marks, revealed feedback, self-assessments, shuffled choice order, mode, and timer start. In practice mode, **Pause** freezes the timer, syncs immediately, and exposes **Resume Practice** on every connected machine. If the connection drops or the page closes, reopening Quizzer restores the latest unfinished session. Submitting the attempt removes its saved draft on every synchronized device.

## Server database and IndexedDB migration

Quizzer stores authoritative metadata, extracted text, tests, attempts, generation jobs, and unfinished sessions in `data/quizzer.sqlite` under the native application-data directory. Original uploaded files and extracted figures are verified by SHA-256 and deduplicated in `objects/sha256`; SQLite stores only immutable references to them. Rebuildable FTS5/BM25 data lives separately in `indexes/sparse.sqlite`, so it is never confused with source data or copied into backups. Unreferenced uploads are retained for 24 hours to protect in-flight sync, then reclaimed during periodic service cleanup. SQLite write-ahead logging protects concurrent browser writes, while an ordered change log propagates updates and deletions between machines.

To migrate the existing Zen Browser library, start this updated version and open Quizzer once in the same Zen profile and at the exact same URL previously used. IndexedDB is isolated by browser profile and URL origin, so this one visit is required for the page to read the old `QuizDB` database. Before accepting the first batch, the service creates and hashes a timestamped SQLite backup under the application-data `backups/migrations` directory. Each imported record is receipted with SHA-256 in the same transaction as its batch; Quizzer verifies the final record count, aggregate hash, and SQLite presence before the browser marks the import complete. The sidebar then changes from **Syncing library** to **Saved on server**. You can open the same Quizzer URL from another machine after that; it downloads the server library automatically.

The initial import merges records by ID in bounded batches and runs behind the usable interface. Existing server records win an initial-import conflict, preventing an old browser cache from replacing a newer shared copy. Later edits are ordered by the server and synchronized every five seconds, when the tab becomes visible, and immediately after reconnecting. While offline, the sidebar shows **Offline — saved locally** and pending mutations remain in IndexedDB. Select the sync row to see preparation, batch and byte-transfer progress, local application, the pending-change count, the latest successful sync time, or the connection error.

When a schema-v1 database still contains the old embedded retrieval tables, Quizzer creates a timestamped SQLite backup and matching SHA-256 checksum under `backups/schema` before removing those rebuildable tables. Source records remain in the authoritative database; retrieval rebuilds in the separate index database on demand.

Use `quizzer migrations list` to inspect IndexedDB migration status, hashes, and retained rollback paths. Use `quizzer backup create` for a consistent live backup of SQLite, configuration, and every content-addressed original; `quizzer backup verify <directory>` re-hashes every entry before you rely on it. After quitting the desktop app and local service, `quizzer backup restore <directory> --yes` verifies the backup again, preserves the current library as a recovery backup, and atomically replaces the database, object store, and safe configuration while clearing derived indexes for rebuild. Source deployments can also stop Quizzer and copy the `.quizzer-data` directory. Set `QUIZZER_DATABASE_PATH` or `QUIZZER_SPARSE_INDEX_PATH` only when custom locations are needed for a packaged or managed deployment.

Authenticated desktop and remote clients can create the same complete backup with `POST /api/v1/backups`, list service-managed backups with `GET /api/v1/backups`, and perform a full integrity verification with `GET /api/v1/backups/{backupId}`. Restore remains an offline CLI operation so the active service cannot replace its own database.

Select **Install Ollama + all-minilm** under **Plugins & models** to enable local semantic duplicate filtering and AI-selected source coverage. On macOS Quizzer uses Homebrew to install Ollama when needed; on Linux it uses Ollama's official installer. It then starts the local runtime and downloads `all-minilm`. If that plugin is unavailable, generation continues automatically with normalized exact matching, lexical similarity, and size-based source prioritization.

## Data and privacy

- Document metadata, extracted text, quizzes, attempts, generation checkpoints, and unfinished sessions are stored in server-side SQLite. Original uploaded files and extracted figures live in the content-addressed object store outside the database.
- Each browser keeps a synchronized IndexedDB cache named `QuizDB` for responsive UI and offline recovery.
- New `Blob` and `File` values are uploaded through the authenticated object API and verified against their SHA-256 address before their reference is synchronized. Legacy base64 records are materialized into the same object store before SQLite accepts them.
- Agent requests use the selected locally authenticated CLI.
- API requests send selected extracted content—and figures for supported multimodal models—to the selected provider.
- API keys pass through the loopback service only for the active request. They remain in browser session storage unless the desktop user explicitly remembers them in the OS-protected credential vault; they are never written to IndexedDB, local storage, settings exports, backups, or diagnostics.
- Deleting browser site data clears only that browser's cache; reopening Quizzer repopulates it from the server.
- Deleting `.quizzer-data` deletes the shared server library. Keep backups of important data.

Do not upload confidential material unless the selected provider and your account's data-handling terms are appropriate for it.

## Commands

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
| `npm run build:cli` | Build the signed standalone CLI with Node.js 26+ |
| `npm run lint` | Run ESLint |
| `npm test` | Run server storage tests |
| `npm run preview` | Preview the browser bundle; start the service separately for generation |

Source development uses loopback port 8787 so Vite can proxy API requests. The packaged desktop app asks the operating system for an unused ephemeral loopback port, waits for an authenticated utility-process ready message, and only then opens the renderer; set `QUIZZER_DESKTOP_SERVICE_PORT` only for a managed desktop deployment that requires a fixed port.

## Troubleshooting

### Quizzer asks for an API key

Enter the provider's key in **Plugins & models → API providers**. Leave **Remember on this device** off for session-only use, or enable it in the desktop app to use OS-protected storage after confirmation.

### `spawn codex ENOENT`

Install Codex CLI and ensure `codex` is available on `PATH` for the process starting Quizzer. Authentication itself can then be completed from **Plugins & models**.

### An agent reaches its usage limit

Open **Generation queue**, select a configured replacement provider on the paused job, and choose **Continue**. Accepted questions are preserved. If the replacement uses an API key you have not entered, open **Plugins & models** directly from the job first.

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

## Development notes

- Provider-specific behavior belongs in the local service; the UI works with Quizzer's internal generation contract.
- Do not assume third-party CLIs share command flags or output events. Add an adapter per provider.
- New quiz fields require both TypeScript types and runtime validation.
- Database schema changes require a new Dexie version and a migration strategy.
- Duplicate thresholds should be evaluated against representative quiz sets before changing defaults.

## Roadmap

- Provider capability discovery and custom endpoint adapters
- Provider-specific concurrency and cost limits
- Question/source citations in the review interface
- Document re-extraction and converter version tracking
- Full automated unit, integration, and browser test suites
- Production packaging for the local service and static application

## Security

Please do not publish suspected vulnerabilities in a public issue. Contact the repository owner privately with reproduction steps and affected versions. The local service binds to loopback only and provider inputs are treated as untrusted, but the project has not yet undergone an independent security review.

## License

This repository currently contains no license file. No permission to redistribute or modify the project should be assumed until the owner adds an explicit license. Optional dependencies, including Marker and its model weights, have their own license terms.
