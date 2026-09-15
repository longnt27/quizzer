import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentExtractor } from '../server/plugin-extraction.mjs';

test('resolves Marker through the common extractor router for explicit and legacy settings', async () => {
  const calls = [];
  const marker = async (data, options) => {
    calls.push({ data: Buffer.from(data).toString('utf8'), options });
    return { content: '# Marker extracted', parserVersion: 'marker-2.0.0', extractor: 'marker' };
  };

  for (const values of [
    { 'extraction.provider': 'marker', 'extraction.marker': true, 'extraction.extractorPlugin': 'builtin' },
    { 'extraction.provider': 'auto', 'extraction.marker': true, 'extraction.extractorPlugin': 'builtin' },
  ]) {
    const route = await resolveDocumentExtractor({ values }, { runMarker: marker });
    assert.equal(route.component, 'marker');
    assert.equal(route.identity, 'marker:2.0.0');
    assert.equal(route.accepts({ name: 'guide.pdf', mimeType: 'application/pdf' }), true);
    assert.equal(route.accepts({ name: 'notes.txt', mimeType: 'text/plain' }), false);
    const result = await route.extract(Buffer.from('pdf'), { name: 'guide.pdf', mimeType: 'application/pdf' });
    assert.equal(result.extractor, 'marker');
  }

  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.data === 'pdf' && call.options.name === 'guide.pdf'), true);
});

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
