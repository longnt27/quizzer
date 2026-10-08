# Measured baseline results

These are actual production-code measurements, not fixture pass rates. The initial run evaluated commit `19de3a7e1cda06aff625a7146f613e19ae92a31d` in [GitHub Actions run 37732408545](https://github.com/longnt27/quizzer/actions/runs/37732408545). The runner executed nine conditions (raw, simulated scans, oracle text across dev/validation/test), three paired comparisons, and extraction of all 48 natural lecture PDFs. No generation model or paid provider was used. Subsequent reruns can update timing fields and provenance; the table below identifies the initial run explicitly.

## Controlled held-out test split

576 bilingual task rows; 408 have nonempty required-evidence labels. Forty-eight logical documents comprise 12 five-page manuals, 12 amendments, and 24 one-page reports. The scan condition replaces the 12 manuals with simulated scans while the other 36 documents remain native. English/Vietnamese translations and repeated templates are dependent observations.

| Metric | Native PDF baseline | Scanned-manual condition |
|---|---:|---:|
| Required-evidence Recall@5 | 44.36% | 14.71% |
| Complete required evidence@5 | 41.18% | 11.76% |
| Required-evidence Recall@10 | 66.91% | 17.65% |
| Page MRR@10 | 0.4213 | 0.1849 |
| Page nDCG@10 | 0.4637 | 0.1657 |
| Correct refusal on unanswerable cases | 58.33% | 100.00% |
| False refusal on answerable/partial/conflicting cases | 52.94% | 77.94% |
| Documents with failed or empty extraction | 0 / 48 | 12 / 48 |
| Macro normalized character error rate | 0.00% | 62.50% |

**Configuration:** production `extractDocumentBuffer` (native PDF.js path, no OCR plugin supplied), production `chunkDocument`, production `SparseDocumentIndex`, 4,096 requested context budget, no neighbors, at most ten retrieved chunks. Ranking metrics collapse returned chunks to unique physical pages before applying cutoffs. This is not a full hybrid/RRF/reranker/generator result. The scan failure does not establish that every configured Quizzer extraction profile fails OCR.

The 100% scan-condition negative refusal rate is NOT success by itself: its 77.94% false-refusal rate shows why both denominators matter. Retrieval scores describe available ranked evidence even where the confidence gate refuses; they must not be relabeled as delivered answer accuracy.

Zero character errors apply to these simple controlled native PDFs under NFC and collapsed-whitespace normalization, not to the 48 natural lecture PDFs or arbitrary document layouts. Raster manuals have no native text layer, and this baseline deliberately has no OCR adapter. Page-presence markers alone are not useful extracted content.

## Oracle-text diagnostic and its confound

The initial oracle test Recall@5 is 46.08%, compared with 44.36% for native PDFs. However, native text and oracle text can normalize to identical words while retaining different paragraph/line segmentation. Those differences change chunk boundaries and retrieval confidence. **The raw-versus-oracle difference is therefore a combined serialization/chunking diagnostic, not a clean causal estimate of text-extraction error or a guaranteed upper bound.** To isolate extraction alone, control chunk segmentation in a separate experiment.

## Natural lecture PDFs

All **48 of 48** real-PDF extraction calls completed without an exception or wholly empty document. This is an operational observation, **not 100% extraction accuracy**. No human transcription or semantic gold exists for those lectures yet; pypdf transcriptions are annotation aids. Per-document page/character observations are recorded in [real-extraction.json](real-extraction.json).

The run emitted PDF.js warnings about a missing `standardFontDataUrl`. They did not abort this baseline. Do not suppress or interpret warnings as passing visual/formula extraction tests.

## Inspect the evidence

- [Exact revision, dependency lock and dataset fingerprints](provenance.json)
- [Native test details](raw-test.json), [scan test details](scan-test.json), [oracle test details](oracle-test.json)
- [Native development details](raw-dev.json), [native validation details](raw-validation.json)
- [Paired test comparison](oracle-gap-test.json), [development comparison](oracle-gap-dev.json), [validation comparison](oracle-gap-validation.json)
- [Initial complete report ZIP](https://github.com/longnt27/quizzer/actions/runs/37732408545/artifacts/11530317914)
- [Metric definitions and reproduction commands](../EVALUATION.md)
- [Actual natural PDFs + upstream links](../corpus/README.md), [controlled PDFs + pre-render semantic gold](../controlled/README.md)

The initial benchmark-specific test command passed **77 tests**, including 43 retained course-pilot tests. These prove evaluator behavior, not high RAG quality. The subsequent local/cloud model guard adds one additional regression test. Repository-wide CI must be checked separately; no claim of overall green CI is implied by this report.

## What remains before strong CV quality claims

Run the complete configured hybrid and generation system against this baseline with matched sources, prompts and budgets. Execute and human-review source-conditioned real-course candidate generation; generic course requests are not an evidence-labeled QA test set. Add independently authored/held-out-template tasks and external benchmarks from #216. Human-judge actual quiz correctness, distractors, ambiguity and claim-level citation support. Report the measured improvement and exact scope, not a claim that all of RAG has been mastered.
