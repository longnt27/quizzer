# Quizzer

Quizzer is a local-first study application that turns a reusable document library into validated multiple-choice quizzes. Documents are uploaded and extracted once, tagged for later discovery, and then selected whenever you want to create either separate quizzes or one combined quiz.

> **Project status:** active development. Local data and the generation pipeline are usable, but this project has not yet published a stable release or completed a security audit.

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
- Configurable mix of multiple-choice, fill-in-the-blank, and reasoning questions
- Normalized fill-in-the-blank grading across generated acceptable wordings
- Learner self-assessment against reference answers for reasoning questions
- In-app Plugins & models panel for setup and defaults
- Codex Agent integration using the user's existing CLI authentication
- Gemini API integration through a local service
- Structured provider output and runtime question validation
- Live generation progress by test, question type, and retry round
- Mid-generation cancellation that stops the active provider process
- Bounded refill attempts: valid questions survive when another candidate is rejected
- Exact and lexical near-duplicate filtering
- Optional local semantic duplicate filtering through Ollama
- Optional Marker PDF conversion with tables, equations, and extracted figures
- Fresh AI-generated practice for concepts missed on the latest attempt
- Local quiz, document, and attempt storage through IndexedDB

## How it works

```text
PDF / Markdown / text
          │
          ▼
  Document extraction ──────► IndexedDB document library
  (Marker or fallback)          content + tags + figures
                                      │
                                      ▼
                              Select document(s)
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                   Codex Agent                Gemini API
                         └────────────┬────────────┘
                                      ▼
                         validate + reject duplicates
                                      ▼
                              saved local quiz
```

The React application never starts shell commands directly. It calls a loopback-only Node service, which invokes provider adapters and keeps API credentials outside browser bundles.

## Requirements

- Node.js 20 or newer
- npm
- At least one generation provider:
  - [Codex CLI](https://developers.openai.com/codex/) installed and authenticated; or
  - a Gemini API key

Marker is optional and can be installed from Quizzer. Local embeddings are detected automatically when provided by an application packager. Neither is required for the basic document and quiz flow.

## Quick start

```sh
git clone https://github.com/Somethings1/quizzer.git
cd quizzer
npm ci --legacy-peer-deps
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`.

`npm run dev` starts both the browser development server and the loopback generation service. The service listens on `127.0.0.1:8787` by default.

### Tailscale access

On macOS, double-click `start-tailscale.command` in Finder. It detects the active Tailscale address, installs npm dependencies when needed, and prints the private URL to open from another device on the same tailnet. Keep its Terminal window open while using Quizzer and press Control-C to stop it.

The same launcher is available from a terminal as `npm run tailscale`. It binds Vite to the Tailscale interface rather than exposing Quizzer on every LAN interface.

## Provider setup

Open **Plugins & models** at the bottom of the sidebar. This panel is the central place to:

- install and check Marker;
- connect Codex using its device sign-in flow;
- enter a Gemini API key;
- save the default provider and model for each provider.

The Create Test dialog starts with those defaults and lets you choose a different provider or model for an individual test.

### Codex Agent

Install the Codex CLI once, then select **Connect Codex** in **Plugins & models**. Quizzer starts the Codex device sign-in flow and displays its sign-in link and instructions in the popup. Quizzer invokes Codex ephemerally, uses a read-only sandbox, and supplies a JSON Schema for the final response. Leaving the model field blank uses the Codex default.

### Gemini API

Enter the Gemini API key and default model in **Plugins & models**. The key is retained only in the current browser tab and sent to the loopback service for requests. No environment variable or terminal configuration is required.

End users do not configure providers in a terminal. Provider connections, model selection, Gemini credentials, quiz settings, and theme selection all live in the application UI.

## PDF conversion

Quizzer offers two upload modes:

- **Automatic:** attempts Marker and falls back to browser-based PDF text extraction.
- **Basic:** uses PDF.js text extraction only.

Select **Install Marker** in **Plugins & models** for better preservation of document structure. Quizzer creates a private Python environment under `.quizzer-tools/marker`, downloads Marker there, and uses it automatically. Installation can take several minutes and requires an internet connection and substantial disk space.

When Marker succeeds, Quizzer stores its Markdown plus up to 30 extracted images and supplies those images to the selected multimodal provider. Marker is a substantial optional dependency and its code/model licenses should be reviewed for your distribution and commercial-use requirements.

Scanned or visually complex documents can still require manual review. Always inspect extracted content before generating a high-stakes quiz.

## Creating a quiz

1. Open the **Documents** sidebar tab.
2. Select **Add documents**, choose files, and optionally assign comma-separated tags.
3. Inspect a document's extracted content from the main view.
4. Open the **Tests** tab and select **Create test**.
5. Filter and select documents by name or tag.
6. Choose one combined quiz or one separate quiz per document.
7. Choose how many multiple-choice, fill-in-the-blank, and reasoning questions to create.
8. Select a provider and optional provider-specific model.
9. Start generation.

Generation requests at most ten candidates of one type at a time. Every candidate is validated independently against its type-specific schema. Valid questions are retained, while invalid or duplicate candidates leave empty slots for a later bounded refill round. If a target cannot be reached after five rounds, Quizzer saves the valid partial quiz and reports the final count instead of retrying forever.

Fill-in-the-blank answers ignore capitalization, punctuation, and repeated spaces, and match any acceptable wording supplied with the generated question. Reasoning answers are never graded by another model: the learner reveals the reference answer, compares the essential points, and records a self-assessment.

Application packagers can optionally bundle or provide Ollama with the default lightweight embedding model:

```sh
ollama pull all-minilm
```

If Ollama is unavailable, generation continues automatically with normalized exact matching and lexical similarity. End users do not need to configure it.

## Data and privacy

- Documents, original uploaded blobs, extracted figures, quizzes, and attempts are stored in the browser's IndexedDB database named `QuizDB`.
- Codex requests use the locally authenticated Codex CLI.
- Gemini requests send selected extracted content and figures to Google's API.
- Deleting browser site data deletes the local Quizzer library.
- Export important quizzes before clearing browser storage.

Do not upload confidential material unless the selected provider and your account's data-handling terms are appropriate for it.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local service and Vite development server |
| `npm run tailscale` | Start Quizzer on this machine's Tailscale address |
| `npm run dev:web` | Start only Vite; generation endpoints must be provided separately |
| `npm run service` | Start only the loopback generation service |
| `npm run build` | Type-check and create the production browser bundle |
| `npm run lint` | Run ESLint |
| `npm run preview` | Preview the browser bundle; start the service separately for generation |

The development service uses its internal loopback port automatically. Packagers may override `QUIZZER_SERVICE_PORT` and the matching Vite proxy when building a custom distribution.

## Troubleshooting

### Quizzer asks for a Gemini key

Enter the key in **Plugins & models → Gemini API**. It is intentionally forgotten when the browser tab closes.

### `spawn codex ENOENT`

Install Codex CLI and ensure `codex` is available on `PATH` for the process starting Quizzer. Authentication itself can then be completed from **Plugins & models**.

### Marker is not used

Open **Plugins & models** and select **Install Marker**. The popup shows live installation progress and any error. Until Marker is ready, Automatic mode silently uses basic extraction.

### A quiz contains fewer questions than requested

The generation pipeline reached its bounded retry limit after rejecting malformed or duplicate candidates. The accepted questions are retained. Try filling the missing concepts again or reduce the requested count for a small source document.

## Development notes

- Provider-specific behavior belongs in the local service; the UI works with Quizzer's internal generation contract.
- Do not assume third-party CLIs share command flags or output events. Add an adapter per provider.
- New quiz fields require both TypeScript types and runtime validation.
- Database schema changes require a new Dexie version and a migration strategy.
- Duplicate thresholds should be evaluated against representative quiz sets before changing defaults.

## Roadmap

- Provider capability discovery and configurable third-party adapters
- Persisted generation jobs and crash recovery
- Question/source citations in the review interface
- Document re-extraction and converter version tracking
- Full automated unit, integration, and browser test suites
- Production packaging for the local service and static application

## Security

Please do not publish suspected vulnerabilities in a public issue. Contact the repository owner privately with reproduction steps and affected versions. The local service binds to loopback only and provider inputs are treated as untrusted, but the project has not yet undergone an independent security review.

## License

This repository currently contains no license file. No permission to redistribute or modify the project should be assumed until the owner adds an explicit license. Optional dependencies, including Marker and its model weights, have their own license terms.
