# Running the course benchmark

This evaluator consumes the candidate dataset in this directory. It does **not** upgrade AI annotations to human-validated gold labels. Until the dataset is reviewed and frozen, collection/scoring requires `--allow-candidate` and reports `exploratory: true`. No real-model quality results are bundled.

## Scope and preparation

Use Node.js 20+ and a separately running Quizzer service. Acquire and freeze source PDFs with the commands in [README.md](README.md), then import the full selected PDFs through Quizzer's existing app or CLI. A complete source lock for all ten documents is required. Keep PDFs, source locks, extracted bodies, raw generated outputs and review packets outside Git. The dataset PR's source hashes remain deliberately null until genuine acquisition and review.

Start with `dev`, tune only on that split, and use `test` after freezing choices. Do not put gold answers or evidence labels into the service, prompts or agent working directory. The collector sends only input queries and selected runtime document IDs.

Prepare a configuration outside the repository, for example:

```json
{
  "baseUrl": "http://127.0.0.1:8787",
  "split": "dev",
  "sourceLockPath": "course-source-lock.json",
  "system": {
    "name": "quizzer-full",
    "gitCommit": "REPLACE_WITH_THE_40_CHARACTER_COMMIT_ACTUALLY_RUNNING"
  },
  "documentMap": {
    "net-physical": "REPLACE_WITH_IMPORTED_DOCUMENT_ID",
    "net-link": "REPLACE_WITH_IMPORTED_DOCUMENT_ID",
    "net-internet": "REPLACE_WITH_IMPORTED_DOCUMENT_ID",
    "net-transport": "REPLACE_WITH_IMPORTED_DOCUMENT_ID",
    "net-application": "REPLACE_WITH_IMPORTED_DOCUMENT_ID"
  }
}
```

The placeholders are intentionally invalid: do not invent document IDs or Git hashes. `sourceLockPath` is relative to the configuration file. Use a fresh output filename for every command. Supply the service token through `QUIZZER_BENCHMARK_TOKEN`, not a JSON configuration or committed file.

## Production retrieval collection

```sh
node scripts/evaluate-course-benchmark.mjs collect /tmp/course-dev.json /tmp/full-retrieval.json --acknowledge-provider-access --allow-candidate
node scripts/evaluate-course-benchmark.mjs score /tmp/full-retrieval.json /tmp/full-retrieval-report.json --allow-candidate
```

The collector checks the imported document's `originalFile.sha256` against the source lock, records a fingerprint of the extracted content/chunks and parser version, then calls the real `/api/v1/retrieval/preview` service path. It does not instantiate the old fixture-only sparse evaluator.

Requests are fixed at ten ranked chunks, a 4,096 context budget and no neighboring-context expansion. These are the **requested production API settings**, not a claim that every model's tokenizer counts identically or that parent context cannot expand inside the implementation. `pageRecallAt5` credits gold physical PDF pages present in the first five ranked chunks. `pageMrrAt10` uses the first relevant chunk's rank. `completeEvidenceAt5` requires every annotated page. Multiple chunks on the same gold page cannot inflate recall. Missing page metadata receives no evidence credit; out-of-scope or impossible page references become explicit task errors.

Refusal is the service's low-confidence-plus-refusal-string decision, not an LLM answerability judgment. Correct refusals are divided by all negative cases; false refusals by all positive cases. Missing predictions and API errors stay in the dataset denominators and errors never count as successful refusals. Inspect missing/error counts alongside refusal rates. Zero denominators are null, not 100%.

Outputs contain per-task status, ranked source locations, actual retrieval method, dense status, indexing-failure flag and timings. No source text, token or raw error response body is saved by the collector. It fingerprints service settings before and after, rejecting a run if they changed. It does not reconfigure the app, delete data or switch models. **The production preview endpoint can create/rebuild indexes and call configured embeddings or query-planning providers**; the explicit provider-access acknowledgement covers that behavior. Pre-import/index sources for warm-query timing. The reported timings include whatever indexing and provider work actually occurred and include recorded errors.

## Generation is recorded and human-reviewed, not silently auto-judged

This PR does not add a second generation implementation or automatically launch paid generation jobs. Export input-only generation tasks with `scripts/course-benchmark-data.mjs`, run them through the existing Quizzer UI/CLI or a documented baseline, and save the delivered outputs as JSONL. Preserve native MCQ fields and source references. One row per dataset task:

```json
{"id":"net-physical-g1","status":"ok","elapsedMs":1234,"questions":[{"id":"q1","type":"multiple-choice","statement":"Example only: replace with the actual generated question","answer":[{"content":"Option A","correct":true,"explanation":"Actual generated explanation"},{"content":"Option B","correct":false}]}]}
```

An error row has `status: "error"` and an empty `questions` array, or the actual partial delivered questions if the job failed after saving some. Never drop malformed or low-quality delivered questions. Missing task rows contribute zero yield. Invalid question IDs or unknown task IDs must be repaired from recorded provenance, not used to hide failures. Preserve retries, rejected candidates, token usage and costs in a separate raw-run audit file; this pilot scorer does **not** aggregate those cost records.

For generation configuration, set `system.generator` to the exact model/version and `system.settingsFingerprint` to the hash of the resolved generation configuration. Keep the full redacted settings, prompts, retry budgets and provider identity with the raw run. The retrieval collector records its settings fingerprint automatically; generation configuration is an operator attestation. This is not automatic proof that two generators received identical prompts or budgets.

```sh
node scripts/evaluate-course-benchmark.mjs record-generation /tmp/generation-config.json /tmp/delivered.jsonl /tmp/generation-run.json --allow-candidate
node scripts/evaluate-course-benchmark.mjs review /tmp/generation-run.json /tmp/reviews.json
# Human reviewers complete every annotation; do not edit generated question contents.
node scripts/evaluate-course-benchmark.mjs score /tmp/generation-run.json /tmp/generation-report.json /tmp/reviews.json --allow-candidate
```

The review packet binds to the exact run fingerprint. Fill real reviewer identity, date, notes and these Boolean dimensions:

| Label | Pass condition |
| --- | --- |
| `correct` | The marked answer is correct and answerable from the selected source. |
| `unambiguous` | Exactly one defensible correct option follows from the wording. |
| `grounded` | The explanation and its attached citations support the substantive claims without contradiction. Check the cited evidence, not merely whether a source ID exists. |
| `distractorsValid` | Wrong options are plausible, well-formed and not additional correct answers. |
| `instructionFollowed` | Requested topic, language, format and restrictions are satisfied. |

Use `duplicateOf` for an earlier equivalent question ID within the same task, otherwise null. Exact normalized repeated statements are also excluded from unique yield. Mechanical MCQ shape checks override optimistic human labels: a blank stem, repeated options, missing Boolean correctness flags, or multiple marked answers cannot be certified valid.

All delivered questions require annotations. Missing, duplicate, extra or incomplete annotations stop scoring rather than creating an attractive partial average. Human identity is an attestation, not technically authenticated by this JSON format. Keep reviewers blind to system names where practicable, randomize review order externally, and independently double-review a stratified sample before adjudication. Automated blinded assignment and inter-rater-agreement tooling are not included in this pilot.

`deliveredValidity = valid / delivered`. `validQuestionYield = valid, nonduplicate delivered / requested`, capped at requested count per task. For a five-question request returning two valid questions, these are 100% and 40% respectively. No delivered questions means validity is null and yield is zero. A quality rubric does not establish student learning improvement or calibrated question difficulty.

## Fair comparisons

Collect a sparse/BM25 configuration and a full hybrid/reranked configuration through the production service under the same source snapshots and request budgets. For end-to-end generation, use the same generator/version, shared task instructions and declared resource limits. Record actual method/dense fallbacks: a failed dense setup must not be presented as a successful hybrid run. To isolate reranking, change only reranking; a whole-pipeline comparison cannot attribute all gains to that one component.

```sh
node scripts/evaluate-course-benchmark.mjs compare /tmp/baseline-report.json /tmp/full-report.json /tmp/comparison.json
```

Comparison rejects mismatched dataset/source fingerprints, splits, protocols, task IDs and generation model names. Deltas are candidate minus baseline in fraction units (multiply by 100 for percentage points), or milliseconds for latency. The scorer returns language/category breakdowns and per-task details. Inspect source-level results and extraction fingerprints in the raw runs as well.

The current test split has only one course family. No population-level bootstrap confidence interval or significance claim is emitted. Public lecture content may also have appeared in model pretraining. These are limitations to document, not metrics to conceal.

## Verification

```sh
node --test test/course-benchmark-*.test.mjs
node scripts/course-benchmark-data.mjs validate
node scripts/evaluate-course-benchmark.mjs --help
```

These contract tests use small synthetic cases and mocked HTTP responses to verify the evaluator, not to claim actual Quizzer quality. Live source ingestion, real retrieval/model runs and human annotation review remain separate prerequisites for measured benchmark results. External public datasets are deferred to #216.
