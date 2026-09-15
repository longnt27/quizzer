#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

SENTINEL = "__QUIZZER_DOCLING__"
MAX_FILE_BYTES = 250 * 1024 * 1024
MAX_PAGES = 1_000_000
DOCUMENT_TIMEOUT_SECONDS = 9 * 60


def build_converter() -> DocumentConverter:
    artifacts_path = Path(sys.prefix) / "artifacts"
    pipeline_options = PdfPipelineOptions(
        artifacts_path=artifacts_path,
        enable_remote_services=False,
        allow_external_plugins=False,
        document_timeout=DOCUMENT_TIMEOUT_SECONDS,
    )
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        }
    )


def export_pages(document) -> list[dict[str, object]]:
    page_numbers = sorted(
        {
            int(page.page_no)
            for page in getattr(document, "pages", {}).values()
            if getattr(page, "page_no", None) is not None
        }
    )
    if not page_numbers:
        markdown = document.export_to_markdown(traverse_pictures=True).strip()
        return [{"page": 1, "markdown": markdown}] if markdown else []

    pages = []
    for page_number in page_numbers:
        markdown = document.export_to_markdown(
            page_no=page_number,
            traverse_pictures=True,
        ).strip()
        if markdown:
            pages.append({"page": page_number, "markdown": markdown})
    return pages


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: docling_extract.py <document-path>")
    source = Path(sys.argv[1]).resolve(strict=True)
    if not source.is_file():
        raise SystemExit("Document path must be a file")
    if source.stat().st_size <= 0 or source.stat().st_size > MAX_FILE_BYTES:
        raise SystemExit("Document exceeds the supported size limit")

    result = build_converter().convert(
        source,
        max_file_size=MAX_FILE_BYTES,
        max_num_pages=MAX_PAGES,
    )
    pages = export_pages(result.document)
    print(f"{SENTINEL}{json.dumps({'pages': pages}, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
