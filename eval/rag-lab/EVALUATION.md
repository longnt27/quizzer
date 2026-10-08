# Raw-document RAG evaluation

This suite evaluates components separately and preserves failures. It is not a certificate of RAG mastery. Real-source and controlled-source results must never be pooled into an impressive-looking single number.

## Inspect and reproduce

Actual PDFs are committed: [48 real lectures with original links](corpus/README.md) and [128 controlled sources plus 32 simulated scans](controlled/README.md). Source bytes are hash-pinned. The 384 natural-course prompts are candidates, not annotated QA gold. The 1,536 controlled rows are 24 shared templates across 32 scenarios and two query languages, not 1,536 independent human-authored questions.

```sh
npm ci
node --test test/rag-lab-*.test.mjs test/course-benchmark-*.test.mjs
node scripts/run-rag-lab.mjs benchmark --mode raw --split test --out /tmp/raw-test.json
node scripts/run-rag-lab.mjs benchmark --mode scan --split test --out /tmp/scan-test.json
node scripts/run-rag-lab.mjs benchmark --mode oracle --split test --out /tmp/oracle-test.json
node scripts/run-rag-lab.mjs compare --left /tmp/raw-test.json --right /tmp/oracle-test.json --out /tmp/gap.json
node scripts/run-rag-lab.mjs real-extraction --out /tmp/real-extraction.json
```

`raw` sends original PDF bytes to production `extractDocumentBuffer`, then production `chunkDocument`, then production `SparseDocumentIndex`. `scan` substitutes the paired simulated scan for each manual; the amendment and reports remain native. `oracle` bypasses extraction using pre-render semantic text, is explicitly diagnostic, and cannot be reported as end-to-end quality. Scan errors and empty page text remain failures, not clean-text fallbacks.

The GitHub workflow runs all three conditions across dev/validation/test. Result files are only meaningful when the workflow succeeded and committed them. `results/provenance.json` identifies the evaluated Git commit, dependency lock, task/gold/source snapshots and run ID. No generator or paid provider is called by these baseline runs. The complete app's hybrid configuration is a separate comparison through the existing production-service collector; these results must not be called a full hybrid/generation evaluation.

## Metric contract

| Layer | Implemented measurement | Interpretation and limits |
|---|---|---|
| Extraction text | Macro page character error rate, word error rate, exact text match | NFC and whitespace normalization; accents preserved. Reference text exists before PDF rendering. Errors can exceed 100% with insertions. Empty reference denominators are null. |
| Extraction completeness | Page presence, page count, exact block presence, empty/failing documents | Page markers alone are not meaningful extracted text. These do not establish visual layout quality. |
| Reading order | Order of matched semantic blocks and pairwise ordering; matched-block coverage | Missing blocks are reported separately; perfect ordering among two found blocks is not complete extraction. |
| Code/formula | Exact normalized presence of pre-render code/formula blocks | Not code execution accuracy, symbolic equivalence, or a formula benchmark score. |
| Structured extraction | Coordinate-bound table-cell P/R/F1 and normalized box IoU primitives | Tested primitives; automatic production runs do not emit these scores because the current extraction result does not expose compatible structures. No invented TEDS score. |
| Retrieval | Precision, page recall, required-evidence recall, complete-evidence success, MRR, AP and binary nDCG at 1/3/5/10 | Collapse repeated hits to unique physical pages in returned order. Up to ten production chunks are requested. This is a page-based protocol, distinct from the older pilot's chunk ranks. |
| Alternatives/multi-hop | Evidence groups with alternative acceptable locations | One alternative satisfies a group; all required groups must be covered for complete evidence. Union-page recall is a separate stricter statistic. |
| Refusal | Negative refusal rate, false refusal rate, error count | Production retrieval confidence, not LLM intent understanding. Clarification cases are not mislabeled as unanswerable. |
| Controlled responses | Action accuracy/macro-F1/confusion; answer-slot accuracy; strict task success; missing-information checks | Requires actual recorded responses. Distinguishes answer, clarify, abstain, partial and conflict. Missing predictions score zero; unsupported slots fail strict success. |
| Performance | Extraction and retrieval p50/p95 latency; estimated context tokens | Hardware and configuration-specific. No invented token-price or dollar estimate. |
| Comparison | Paired source-family bootstrap for evidence Recall@5 differences | Few families and shared templates limit inference. This is conditional uncertainty, not broad-domain significance. |
| Quiz and citations | Existing human review protocol retains correctness, ambiguity, distractors, instruction following, source support, validity and requested-question yield | No automatic claim-level citation entailment or learning-outcome claim. The existing course-pilot recorder is not silently treated as an adapter for all new natural prompts. |

Structured predictions for controlled response scoring are JSONL rows: `id`, `action`, `answers` (named slots), `missingInformation` (normalized slot identifiers), optional `error`. This contract is for structured evaluators; free-text answers need a separately validated adapter or human review, not keyword matching.

```sh
node scripts/run-rag-lab.mjs score --tasks eval/rag-lab/controlled/tasks.jsonl --predictions /tmp/actual-responses.jsonl --out /tmp/response-scores.json
```

Gold data is available to scoring, never to retrieval/model prompts. Compare identical task/source fingerprints, selected scope, generator/version and budgets. Changing a retriever and a model together does not isolate the retriever's contribution. Inspect per-language, per-intent, per-variant and per-family results rather than only aggregate means. Current split families still share templates; a future held-out-template track must be separately authored.

## Source-conditioned synthetic expansion

The deterministic controlled generator has already produced inspectable PDFs and programmatic oracle labels. The optional model-based path below is different: it drafts new candidates from real-course excerpts and does not upgrade them to human gold.

```sh
node scripts/run-rag-lab.mjs synthesize --model YOUR_ALREADY_INSTALLED_MODEL --acknowledge-local-model --split dev --limit 192 --out /tmp/course-candidates.jsonl
```

Only a literal HTTP loopback Ollama endpoint is accepted; model pulls and remote providers are not supported. The tool records the installed model digest, server version, prompt hash/version, sampled pages, generation settings and seed. It validates literal supporting quotations against the supplied page text, requires two pages for multi-hop and two grounded interpretations for ambiguity, rejects near duplicates, and saves an audit/rejection log. It never concludes that a question is unanswerable merely because a sampled excerpt lacks the answer.

A verified quote is necessary but not sufficient for semantic correctness. Review candidates against the actual PDF, including the rest of the selected corpus, before freezing them. The supplied pypdf transcription is an annotation aid, never extraction gold. Model-generated data can inherit generator bias and pretraining contamination; record those limits. Keep all derived queries, translations and layout variants in the original source-family split.

## Still not claimed or silently substituted

No human evaluation, local-model generation run, state-of-the-art score, improved learning outcome, natural-scan OCR accuracy, calibrated difficulty, semantic citation precision, table TEDS, or official external-benchmark result is claimed merely because scripts and metric tests pass. Independent external tracks and extraction benchmarks remain in #216. A different PDF parser's output is not human ground truth. The unredistributed TailieuHUST originals remain link-only pending permission; the MIT corpus retains CC BY-NC-SA rights and must not ship inside the commercial application.
