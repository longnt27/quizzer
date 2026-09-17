import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentExtractor } from '../server/plugin-extraction.mjs';

test('routes the managed Docling component without treating it as a third-party plugin', async () => {
  const signal = new AbortController().signal;
  let invocation;
  const route = await resolveDocumentExtractor({
    values: { 'extraction.extractorPlugin': 'docling' },
  }, {
    loadDoclingRuntime: async () => ({
      python: '/managed/docling/bin/python',
      scriptPath: '/runtime/docling_extract.py',
    }),
    runDocling: async (data, options) => {
      invocation = { data: Buffer.from(data), options };
      return {
        content: '--- Page 1 ---\nDocling text',
        pageCount: 1,
        parserVersion: 'docling-2.126.0',
        extractor: 'docling',
      };
    },
  });

  const extracted = await route.extract(Buffer.from('pdf'), {
    name: 'paper.pdf', mimeType: 'application/pdf', signal,
  });

  assert.equal(route.component, 'docling');
  assert.equal(route.identity, 'docling:2.126.0');
  assert.deepEqual(invocation.data, Buffer.from('pdf'));
  assert.equal(invocation.options.python, '/managed/docling/bin/python');
  assert.equal(invocation.options.scriptPath, '/runtime/docling_extract.py');
  assert.equal(invocation.options.name, 'paper.pdf');
  assert.equal(invocation.options.mimeType, 'application/pdf');
  assert.equal(invocation.options.signal, signal);
  assert.equal(extracted.parserVersion, 'docling-2.126.0');
});
