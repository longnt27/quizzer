#!/usr/bin/env python3
"""Run the bounded acquisition engine with the reviewed collection selection."""
import argparse
import importlib.util
import json
from pathlib import Path

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--acknowledge-noncommercial-source-terms', action='store_true', required=True)
    parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    selection = json.loads((root / 'eval/rag-lab/collection.json').read_text())
    spec = importlib.util.spec_from_file_location('acquisition', root / 'scripts/acquire-rag-lab.py')
    acquisition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(acquisition)
    available = {course[0] for course in acquisition.COURSES}
    if not set(selection['families']).issubset(available):
        raise ValueError('Unknown course family in reviewed collection')
    acquisition.COURSES = [c for c in acquisition.COURSES if c[0] in selection['families']]
    acquisition.acquire(per_course=selection['perCourse'])
