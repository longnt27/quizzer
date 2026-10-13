# Course benchmark candidate pilot

This is a **candidate evaluation dataset**, separate from the deterministic `eval/rag` regression fixtures. It contains original annotations, not redistributed course documents or copied examination questions. No model-quality score or human-validation claim is included.

## Contents and scope

| Item | Development | Held-out test | Total |
| --- | ---: | ---: | ---: |
| Full lecture PDF references | 5 | 5 | 10 |
| Source pages, from extracted PDF metadata | 196 | 185 | 381 |
| Retrieval cases | 30 | 30 | 60 |
| Answerable / unanswerable | 20 / 10 | 20 / 10 | 40 / 20 |
| Quiz-generation requests | 10 | 10 | 20 |
| Requested MCQs per system | 50 | 50 | 100 |

All source documents are Vietnamese. Retrieval queries are evenly split between Vietnamese and English; English queries are a **cross-lingual retrieval slice**, not an English-document corpus. There are ten Vietnamese and ten English generation requests. Reference-answer paraphrases are in English and are never model inputs.

Sources were discovered through TailieuHUST's [networking catalog](https://tailieuhust.com/tai-lieu-mang-may-tinh-hust/) and [information-security catalog](https://tailieuhust.com/nhap-mon-an-toan-thong-tin/). Annotations reference instructor-hosted PDFs on `users.soict.hust.edu.vn`, listed in `v1/sources.json`. **Equivalence to the catalog's inaccessible Google Drive mirrors is not asserted.**

IT3080 networking is development data; the entire IT4015 security course is held out. No lecture from either family crosses the split. Both courses share an instructor and are related technical subjects: this is a limited pilot, not representative sampling of HUST or general education. A single held-out family is insufficient for a population-level cluster confidence interval.

## Provenance and rights

TailieuHUST's [policy](https://tailieuhust.com/policy/) does not establish a redistribution license for all contributed material. Source rights remain with their owners. The repository's Apache-2.0 license applies to **our original annotations and code only**. PDFs, extracted full text, screenshots, mirrors, paid materials and exam banks must not be committed. This follows `CONTRIBUTING.md`.

Source text was inspected through extracted PDF text. Binary downloads and screenshot rendering failed in the authoring environment. Consequently, source `sha256` fields are deliberately null, and visual verification is explicitly pending. They are not fake hashes of URLs. Source page counts and evidence labels are provisional until the acquired bytes and page numbering have been checked.

## Validate and export inputs

Node.js 20+; no additional dependencies are required for these commands:

```sh
node scripts/course-benchmark-data.mjs validate
node --test test/course-benchmark-dataset.test.mjs test/course-benchmark-sources.test.mjs
node scripts/course-benchmark-data.mjs export retrieval dev /tmp/retrieval-inputs.jsonl
node scripts/course-benchmark-data.mjs export generation test /tmp/generation-inputs.jsonl
```

Outputs are created exclusively; an existing output is not silently overwritten. Exports whitelist only task ID, selected document IDs, language, query/prompt and generation requirements. Gold answers, evidence pages and annotation notes never enter the exported model input.

## Acquire and freeze source bytes

Only acquire material you are entitled to use. Keep the cache outside the repository. The downloader is opt-in, host-allowlisted, size/time bounded, rejects redirects and HTML responses, and generates SHA-256 values from the actual downloaded bytes.

```sh
node scripts/benchmark-sources.mjs /tmp/quizzer-course-pdfs /tmp/course-source-lock.json --acknowledge-source-terms
# Reproduce exactly those bytes later; use a new lock output filename.
node scripts/benchmark-sources.mjs /tmp/quizzer-course-pdfs /tmp/course-source-lock-recheck.json --acknowledge-source-terms /tmp/course-source-lock.json
```

The lock is written only after every source succeeds. A source hash mismatch fails, rather than silently updating the corpus. A failed acquisition can leave partial PDFs in the chosen local cache, but cannot produce a complete lock. A byte hash proves identity, **not permission, page-label accuracy or question correctness**. Review the lock and promote source hashes into the manifest as part of freezing a reviewed dataset version. The optional manually dispatched CI acquisition job uploads only the complete hash manifest, never the PDFs.

## Annotation contract

`retrieval.jsonl` has one original query per row. `documentIds` are the complete allowed scope: import the **full selected PDFs**, not only their labeled evidence pages. `evidence` contains required page-level evidence units. All listed pages are required for complete-evidence scoring; individual pages count toward partial recall. These are **one-based physical PDF page numbers**, not slide numbers. Several sources print two slides per PDF page. Page-level retrieval credit is coarse and optimistic; it is not passage entailment or citation precision.

The answerable cases include factual retrieval, paraphrases, applied calculations and multi-page comparisons. Negative cases keep domain vocabulary but omit necessary parameters, request unavailable local facts, generalize examples beyond their support, or ask for live facts absent from the source snapshot. They are not unrelated-topic smoke tests. However, they need full-source review to ensure that an answer is genuinely absent and that the right behavior is a qualified refusal rather than an ordinary answer.

`generation.jsonl` specifies five single-answer MCQs per task, with language, scope and instruction constraints. It intentionally does **not** supply a reference quiz: different valid questions may meet the same request.

## Human review and sealing

Every record currently has `review.status = "candidate"`, `author = "ai"`, and no human reviewer. Before reporting headline quality:

1. Acquire a complete source lock; verify physical PDF pages and inspect relevant figures/tables. Correct source errors or exclude outdated/ambiguous claims instead of treating a lecture as infallible.
2. Review each positive against the whole source, identify alternative supporting pages, and adjudicate evidence completeness. Review each negative against the entire selected PDF, not just nearby paragraphs. The current gold page sets are not exhaustively audited.
3. Record a real reviewer and ISO review date for reviewed records. A second reviewer should independently check a stratified subset and resolve disagreements. Do not label AI self-checks as human review.
4. Freeze the reviewed version, source pins, scoring rubric and test IDs before tuning. Do not silently modify held-out labels or sources to improve a run. Test-case-driven fixes belong to the next development version and require a fresh holdout for new generalization claims.

For generated MCQs, judge correctness, answer uniqueness, source support of explanations, distractor validity and instruction compliance. Judge duplication within each quiz. An answer or distractor cannot be certified merely because it shares source keywords. Report validity among delivered questions **and** valid nonduplicate yield per requested question, including failures. Do not claim student learning gains or empirically calibrated difficulty from these annotations.

External public-dataset integration is tracked separately in issue #216.
