import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentExtractor } from '../server/plugin-extraction.mjs';

test('resolves the official Mistral OCR extractor without requiring an installed plugin', async () => {
  let credentialProvider;
  let requestBody;
  const route = await resolveDocumentExtractor({ values: { 'extraction.extractorPlugin': 'mistral-ocr' } }, {
    loadCredential: provider => {
      credentialProvider = provider;
      return 'mistral-key';
    },
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ pages: [{ index: 0, markdown: '# Cloud extracted' }] }), { status: 200 });
    },
  });

  assert.equal(route.component, 'mistral-ocr');
  assert.equal(route.identity, 'mistral-ocr:mistral-ocr-4-1');
  const result = await route.extract(Buffer.from('pdf'), { name: 'guide.pdf', mimeType: 'application/pdf' });
  assert.equal(credentialProvider, 'mistral-ocr');
  assert.equal(requestBody.model, 'mistral-ocr-4-1');
  assert.equal(result.extractor, 'mistral-ocr');
  assert.equal(result.parserVersion, 'mistral-ocr-4-1');
});

test('does not silently fall back when Mistral is explicitly selected but unconfigured', async () => {
  const route = await resolveDocumentExtractor({ values: { 'extraction.extractorPlugin': 'mistral-ocr' } }, {
    loadCredential: () => undefined,
  });
  await assert.rejects(route.extract(Buffer.from('pdf')), error => error.code === 'provider_unavailable' && /API key is required/.test(error.message));
});
