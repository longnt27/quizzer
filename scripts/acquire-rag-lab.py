#!/usr/bin/env python3
"""Acquire an attributed noncommercial research corpus; never relabel parser output as gold."""
import argparse
import hashlib
import html
import io
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'eval' / 'rag-lab' / 'corpus'
LIMIT = 16 * 1024 * 1024
LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
TERMS = 'https://ocw.mit.edu/pages/privacy-and-terms-of-use/'
COURSES = [
    ('algorithms', 'dev', '6-006-introduction-to-algorithms-fall-2011', 'Erik Demaine; Srini Devadas'),
    ('probability', 'validation', '6-041-probabilistic-systems-analysis-and-applied-probability-fall-2010', 'John Tsitsiklis'),
    ('automata', 'test', '6-045j-automata-computability-and-complexity-spring-2011', 'Scott Aaronson; Nancy Lynch; credited student scribes'),
    ('operating-systems', 'test', '6-828-operating-system-engineering-fall-2012', 'Frans Kaashoek'),
    ('databases', 'dev', '6-830-database-systems-fall-2010', 'Samuel Madden; Robert Morris; Michael Stonebraker; Carlo Curino'),
    ('machine-learning', 'test', '6-867-machine-learning-fall-2006', 'Tommi Jaakkola; Rohit Singh; Ali Mohammad'),
    ('data-science', 'validation', '6-0002-introduction-to-computational-thinking-and-data-science-fall-2016', 'Eric Grimson; John Guttag; Ana Bell'),
]


def check_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or p.hostname != 'ocw.mit.edu' or p.username or p.password or p.port not in (None, 443):
        raise ValueError('Only HTTPS MIT OCW source URLs without credentials are allowed')
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_bytes(url):
    check_url(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'Quizzer-research-benchmark/0.2 (bounded educational corpus)'})
    with urllib.request.build_opener(SafeRedirect).open(request, timeout=35) as response:
        if response.status != 200:
            raise ValueError('Source response was not successful')
        data = response.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError('Source exceeds the 16 MiB limit')
        return data


def pdf_links(markup, base):
    found = []
    for raw in re.findall(r'''href\s*=\s*["']([^"']+)["']''', markup, re.I):
        url = urllib.parse.urljoin(base, html.unescape(raw)).split('#')[0]
        name = urllib.parse.urlsplit(url).path.rsplit('/', 1)[-1].lower()
        if not name.endswith('.pdf') or not re.search(r'(?:lec|lecture)[_-]?\d+', name):
            continue
        if any(x in name for x in ('original', '_orig', 'handout', 'selinger', 'slides_all')):
            continue
        try:
            check_url(url)
        except ValueError:
            continue
        if url not in found:
            found.append(url)
    return sorted(found, key=lambda x: (int(re.search(r'(?:lec|lecture)[_-]?(\d+)', x.lower())[1]), x))


def sample_links(links, n):
    if len(links) <= n:
        return links
    return [links[round(i * (len(links) - 1) / (n - 1))] for i in range(n)] if n > 1 else links[:1]


def source_id(family, url):
    return 'ocw-' + family + '-' + hashlib.sha256(url.encode()).hexdigest()[:12]


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def acquire(per_course=8):
    from pypdf import PdfReader
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / 'sources.json'
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    locked = {s['id']: s for s in old}
    sources, rejected, requests = [], [], []
    for family, split, slug, authors in COURSES:
        catalog = f'https://ocw.mit.edu/courses/{slug}/resources/lecture-notes/'
        previous = [s['url'] for s in old if s['family'] == family]
        links = previous or sample_links(pdf_links(fetch_bytes(catalog).decode('utf-8'), catalog), per_course)
        if len(links) < per_course:
            raise ValueError(f'{family}: found only {len(links)} individual lecture PDFs, require {per_course}')
        accepted = 0
        for url in links:
            sid = source_id(family, url)
            target = OUT / 'pdfs' / f'{sid}.pdf'
            data = target.read_bytes() if target.exists() else fetch_bytes(url)
            if not data.startswith(b'%PDF-'):
                raise ValueError(f'{sid}: not a PDF')
            digest = hashlib.sha256(data).hexdigest()
            if sid in locked and locked[sid]['sha256'] != digest:
                raise ValueError(f'{sid}: source bytes changed; do not silently replace a frozen source')
            pdf = PdfReader(io.BytesIO(data))
            if pdf.is_encrypted:
                raise ValueError(f'{sid}: encrypted PDF')
            pages = [{'page': n + 1, 'text': p.extract_text() or ''} for n, p in enumerate(pdf.pages)]
            joined = '\n'.join(p['text'] for p in pages)
            if re.search(r'(excluded from|not covered by) (?:the |our )?creative commons', joined, re.I):
                rejected.append({'url': url, 'reason': 'explicit license exclusion; manual rights review required'})
                continue
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(data)
            title = next((x.strip() for x in pages[0]['text'].splitlines() if len(x.strip()) > 8), url.rsplit('/', 1)[-1])[:180]
            source = {'id': sid, 'family': family, 'split': split, 'language': 'en', 'title': title,
                      'authors': authors, 'publisher': 'MIT OpenCourseWare', 'catalogUrl': catalog, 'url': url,
                      'license': 'CC-BY-NC-SA-4.0', 'licenseUrl': LICENSE, 'termsUrl': TERMS,
                      'modified': False, 'pdf': f'pdfs/{sid}.pdf', 'sha256': digest, 'bytes': len(data),
                      'pages': len(pages), 'transcription': f'transcriptions/{sid}.json',
                      'transcriptionStatus': 'machine-reference-not-extraction-gold',
                      'acquiredOn': '2026-10-08', 'annotationStatus': 'candidate'}
            sources.append(source)
            dump(OUT / source['transcription'], {'sourceId': sid, 'sourceSha256': digest,
                 'method': 'pypdf-5.9.0 independent source inspection; NOT extraction ground truth', 'pages': pages})
            goals = [
                ('quiz', 'Create five single-answer multiple-choice questions. Cover distinct concepts and cite supporting pages.'),
                ('multi-intent', 'First summarize the main idea, then create three application questions and two conceptual questions. Cite evidence for each answer.'),
                ('ambiguous-intent', 'Help me prepare for the exam using this lecture. Before choosing a quiz format, ask which topics and difficulty I want.'),
                ('scoped-comparison', 'Compare two related concepts actually covered in the selected lecture. Then create a question testing their difference. Do not invent a second concept if the source does not support one.'),
                ('grounded-summary', 'Explain the main argument in plain language and identify its assumptions. Cite the source pages.'),
                ('coverage', 'Make a five-item study plan spanning the beginning, middle and end of this lecture, supported by page references.'),
                ('instruction-conflict', 'Create exactly five questions and exactly three questions in a single quiz. Ask me to resolve the incompatible count requirements.'),
                ('vietnamese-quiz', 'Tao nam cau hoi trac nghiem bang tieng Viet, moi cau co mot dap an dung va dan trang nguon. Khong lap lai cung mot y.'),
            ]
            for intent, prompt in goals:
                requests.append({'id': f'{sid}-{intent}', 'sourceFamily': family, 'split': split,
                    'language': 'vi' if intent == 'vietnamese-quiz' else 'en', 'documentIds': [sid], 'intent': intent,
                    'prompt': prompt, 'sourceSha256': digest, 'review': {'status': 'candidate', 'author': 'ai-template', 'humanReviewer': None},
                    'rubric': ['source-support', 'instruction-following', 'clarity', 'coverage', 'no-duplicate-credit'],
                    'referenceAnswer': None})
            accepted += 1
            print(json.dumps({'source': sid, 'pages': len(pages), 'sha256': digest}), flush=True)
            time.sleep(0.05)
        if accepted < per_course:
            raise ValueError(f'{family}: rights exclusions left only {accepted} sources; revise manifest explicitly')
    if sum(s['bytes'] for s in sources) > 160 * 1024 * 1024:
        raise ValueError('Corpus exceeds the 160 MiB repository budget')
    dump(manifest_path, sources)
    dump(OUT / 'acquisition-report.json', {'sourceCount': len(sources), 'familyCount': len(COURSES),
         'pages': sum(s['pages'] for s in sources), 'bytes': sum(s['bytes'] for s in sources),
         'generationRequests': len(requests), 'excluded': rejected, 'humanReviewed': 0})
    (OUT / 'generation.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in requests), encoding='utf-8')
    rows = ['# Inspectable course PDF corpus', '',
        'Unmodified lecture PDFs for noncommercial research, with original rights preserved. No MIT endorsement is implied.',
        f'License: [CC BY-NC-SA 4.0]({LICENSE}); [MIT OCW terms]({TERMS}). These documents and derived transcriptions are NOT Apache-2.0 and must NOT be shipped in the app or a commercial dataset.', '',
        'Transcriptions are machine references for annotation, NOT gold extraction labels. PDF acquisition and byte hashes do not prove semantic annotation correctness.', '',
        '| Source | Split | Pages | PDF in this PR | Original |', '|---|---|---:|---|---|']
    for s in sources:
        rows.append(f"| {s['family']}: {s['title'].replace('|', '/')} | {s['split']} | {s['pages']} | [PDF]({s['pdf']}) | [Source]({s['url']}) |")
    rows += ['', '## Attribution', '']
    rows += [f'- {authors}. {slug}. Massachusetts Institute of Technology: MIT OpenCourseWare. CC BY-NC-SA 4.0. Original files unchanged.' for _, _, slug, authors in COURSES]
    (OUT / 'README.md').write_text('\n'.join(rows) + '\n', encoding='utf-8')
    (OUT / 'LICENSE-NOTICE.md').write_text(f'# Third-party material\n\nMIT OpenCourseWare PDFs and derived transcriptions: CC BY-NC-SA 4.0, {LICENSE}\nAttribution and original source links are in README.md and sources.json. Originals are unchanged.\nDo not redistribute this corpus under the repository Apache license or bundle it in commercial releases.\n', encoding='utf-8')
    print(json.dumps({'complete': True, 'sources': len(sources), 'pages': sum(s['pages'] for s in sources)}), flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--acknowledge-noncommercial-source-terms', action='store_true', required=True)
    ap.parse_args()
    acquire()
