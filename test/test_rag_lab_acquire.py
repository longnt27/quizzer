import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / 'scripts' / 'acquire-rag-lab.py'

class AcquisitionContract(unittest.TestCase):
    def load(self):
        self.assertTrue(MODULE.is_file())
        spec = importlib.util.spec_from_file_location('acquire', MODULE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_rejects_off_host_credentials_and_plain_http(self):
        m = self.load()
        for url in ['http://ocw.mit.edu/x.pdf', 'https://evil.example/x.pdf', 'https://user@ocw.mit.edu/x.pdf', 'https://ocw.mit.edu:8443/x.pdf']:
            with self.assertRaises(ValueError): m.check_url(url)
        self.assertEqual(m.check_url('https://ocw.mit.edu/x.pdf'), 'https://ocw.mit.edu/x.pdf')

    def test_filters_and_deduplicates_numbered_lecture_pdfs(self):
        m = self.load()
        links = m.pdf_links('<a href="/x_lec01.pdf">a</a><a href="/x_lec01.pdf">b</a><a href="/exam.pdf">x</a><a href="/x_lec02_original.pdf">x</a>', 'https://ocw.mit.edu/')
        self.assertEqual(links, ['https://ocw.mit.edu/x_lec01.pdf'])

    def test_selection_spans_start_and_end_without_duplicates(self):
        selected = self.load().sample_links(list(range(25)), 8)
        self.assertEqual(len(selected), 8)
        self.assertEqual(len(set(selected)), 8)
        self.assertEqual((selected[0], selected[-1]), (0,24))

    def test_identifiers_are_stable_not_claimed_content_hashes(self):
        m = self.load()
        self.assertEqual(m.source_id('a','https://ocw.mit.edu/x.pdf'), m.source_id('a','https://ocw.mit.edu/x.pdf'))
        self.assertNotEqual(m.source_id('a','https://ocw.mit.edu/x.pdf'), m.source_id('b','https://ocw.mit.edu/x.pdf'))

    def test_probability_lecture_short_name(self):
        links = self.load().pdf_links('<a href="/courses/prob/abc_MIT6_041F10_L01.pdf">PDF</a>', 'https://ocw.mit.edu/')
        self.assertEqual(len(links), 1)

if __name__ == '__main__': unittest.main()
