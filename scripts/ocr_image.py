import json
import sys

from rapidocr import RapidOCR


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: ocr_image.py <image>")
    result = RapidOCR()(sys.argv[1])
    texts = list(getattr(result, "txts", None) or [])
    print("__QUIZZER_OCR__")
    print(json.dumps(texts, ensure_ascii=False))


if __name__ == "__main__":
    main()
