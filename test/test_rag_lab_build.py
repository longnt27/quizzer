import importlib.util
import unittest
from pathlib import Path
import tempfile
import hashlib

MODULE = Path(__file__).parents[1] / 'scripts' / 'build-rag-lab.py'

class ControlledCorpusContract(unittest.TestCase):
    def load(self):
        self.assertTrue(MODULE.is_file(), 'controlled corpus generator is not implemented')
        spec = importlib.util.spec_from_file_location('build_rag_lab', MODULE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_family_disjointness_and_real_counts(self):
        docs, cases = self.load().make_worlds()
        self.assertEqual(len(docs), 128)
        self.assertGreaterEqual(len(cases), 1400)
        groups = {}
        for d in docs: groups.setdefault(d['family'], set()).add(d['split'])
        self.assertTrue(all(len(splits) == 1 for splits in groups.values()))
        self.assertEqual(set(d['language'] for d in docs), {'en', 'vi'})

    def test_gold_references_and_negative_scopes_are_valid(self):
        docs, cases = self.load().make_worlds()
        by_id = {d['id']: d for d in docs}
        for case in cases:
            for group in case['gold']['evidenceGroups']:
                self.assertTrue(group['alternatives'])
                for ev in group['alternatives']:
                    self.assertIn(ev['documentId'], case['documentIds'])
                    self.assertIn(ev['blockId'], [b['id'] for p in by_id[ev['documentId']]['pages'] for b in p])
            if case['intent'] == 'scope-boundary':
                self.assertNotIn(case['scenarioId'] + '-amendment', case['documentIds'])
                self.assertEqual(case['gold']['action'], 'abstain')

    def test_ambiguity_and_absence_are_different_labels(self):
        docs, cases = self.load().make_worlds()
        labels = {c['gold']['action'] for c in cases}
        self.assertEqual(labels, {'answer', 'clarify', 'abstain', 'partial', 'conflict'})
        self.assertGreaterEqual(len(set(c['intent'] for c in cases)), 22)
        self.assertTrue(all(c['review']['humanReviewer'] is None for c in cases))

    def test_reproducible_generation_and_seed_variation(self):
        m = self.load()
        self.assertEqual(m.make_worlds(123), m.make_worlds(123))
        self.assertNotEqual(m.make_worlds(123), m.make_worlds(124))

    def test_model_input_excludes_gold_and_target_intent(self):
        m = self.load()
        _, cases = m.make_worlds()
        projected = m.model_input(cases[0])
        self.assertEqual(set(projected), {'id','query','history','documentIds','language'})
        self.assertNotIn('gold', projected)
        self.assertNotIn('intent', projected)

    def test_rendered_pdf_and_gold_are_independent_and_deterministic(self):
        m = self.load()
        docs, _ = m.make_worlds()
        from pypdf import PdfReader
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'one.pdf'
            gold = m.render_document(docs[0], path)
            first = path.read_bytes()
            m.render_document(docs[0], path)
            self.assertEqual(hashlib.sha256(first).hexdigest(), hashlib.sha256(path.read_bytes()).hexdigest())
            pdf = PdfReader(path)
            self.assertEqual(len(pdf.pages), len(docs[0]['pages']))
            self.assertEqual(len(gold), len(pdf.pages))
            self.assertTrue(all(g['referenceOrigin'] == 'pre-render-semantic-blocks' for g in gold))
            self.assertTrue(all(0 <= n <= 1 for g in gold for b in g['blocks'] for n in b['bbox']))
            self.assertIn(docs[0]['title'], pdf.pages[0].extract_text())

if __name__ == '__main__': unittest.main()
