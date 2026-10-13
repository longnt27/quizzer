# Quizzer RAG lab

An auditable benchmark suite, not a claim that every RAG problem is solved. The existing course pilot is preserved separately in `../course-benchmark`.

## Inspect the actual PDFs

- [Licensed course PDFs and original source links](corpus/README.md): the acquisition workflow commits the unmodified PDFs, SHA-256 fingerprints, and full attribution. The reviewed collection selects 8 lectures from each of 6 course families, subject to successful acquisition.
- [Original controlled PDFs, scan variants, and semantic gold](controlled/README.md): 128 logical documents, 32 paired raster variants, 256 native pages, and 1,536 bilingual task rows. The 24 intent templates form 768 bilingual semantic pairs in 32 scenario groups. Do not count these as 1,536 independent human-written questions.
- [Collection selection and exclusions](collection.json). TailieuHUST originals remain directly linked in [the source manifest](../course-benchmark/v1/sources.json); free access did not establish a redistribution license. One OCW course is excluded after explicit third-party license exclusions were encountered.

Generated README links become valid when materialization succeeds; a script existing is not proof that PDFs were acquired. Check the committed acquisition report and file hashes.

## Reproduce

```sh
python -m pip install pypdf==5.9.0 reportlab==4.4.9 pypdfium2==5.8.0 Pillow==12.3.0
# On Debian/Ubuntu, install fonts-dejavu-core.
python -m unittest discover -s test -p 'test_rag_lab_*.py'
python scripts/materialize-rag-lab.py --acknowledge-noncommercial-source-terms
python scripts/build-rag-lab.py
```

The reviewed collection wrapper restricts the acquisition engine to `collection.json`. Running the engine over all discovery candidates can deliberately fail at a source-rights exclusion. Do not weaken that check to obtain a prettier document count.

## Evaluation layers

The evaluator PR adds raw-PDF extraction and production sparse-retrieval runs, an oracle-text diagnostic, and offline scoring for generated responses. The existing production-service collector remains available for the full configured hybrid pipeline. Keep real-course, controlled, native, and degraded results separate.

Controlled tasks cover direct/paraphrased retrieval, table lookup, aggregation, multi-hop integration, temporal amendments, comparison, code tracing, formulas, diagrams, late-page evidence, multiple intents, ambiguous entities/versions, absent private/live facts, partial answers, conflicting reports, false premises, a narrow prompt-injection example, source-scope boundaries, conversational follow-ups, unresolved references, and conflicting instructions.

Natural-course requests cover grounded quizzes, summaries, comparisons, coverage, multiple intents and instruction conflicts. They are candidates requiring human or separately calibrated judgment, not programmatic gold. Reference transcriptions from pypdf are annotation aids, never extraction ground truth.

## Integrity rules

Source PDFs enter the production extractor. Extraction errors and empty scanned-page output remain failures; do not replace them with the oracle. Oracle-text runs are diagnostic and cannot be labeled end-to-end.

Controlled gold text, block boxes, tables, code, and diagram edges exist before PDF rendering. Scoring may read them; retrieval/generation inputs may not. Rotated/skewed variants need inverse coordinate transforms before box scoring.

Splits isolate course/scenario families. Shared templates are still shared: this suite measures controlled robustness, not unseen-template generalization. Model-generated expansions must retain parent IDs, source hashes, model/prompt versions, rejection logs, and candidate review status. Human review must name an actual reviewer.

## Rights

Original controlled documents and code use the repository Apache-2.0 license. MIT OpenCourseWare PDFs and derived transcriptions retain **CC BY-NC-SA 4.0**, attribution and noncommercial/share-alike restrictions; see each corpus notice. They must not be relicensed as Apache or included in commercial application packages. No MIT endorsement is implied.

External benchmarks, including independent document-extraction datasets, remain tracked in #216. Do not describe a locally named metric as an official benchmark implementation without implementing its actual protocol.
