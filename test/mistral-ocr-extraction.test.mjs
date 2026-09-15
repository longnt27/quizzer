import assert from 'node:assert/strict';
import test from 'node:test';
import { runMistralOcrExtraction } from '../server/mistral-ocr-extraction.mjs';

test('sends a bounded base64 document to Mistral OCR 4.1 and preserves page boundaries', async () => {
  let request;
  const fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      pages: [
        { index: 0, markdown: '# First page\n\nHello.' },
        { index: 1, markdown: '## Second page\n\nWorld.' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await runMistralOcrExtraction(Buffer.from('pdf bytes'), {
    apiKey: 'test-key', name: 'notes.pdf', mimeType: 'application/pdf', fetch,
  });

  assert.equal(request.url, 'https://api.mistral.ai/v1/ocr');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'mistral-ocr-4-1');
  assert.equal(body.document.type, 'document_url');
  assert.equal(body.document.document_url, `data:application/pdf;base64,${Buffer.from('pdf bytes').toString('base64')}`);
  assert.equal(body.include_image_base64, false);
  assert.equal(result.pageCount, 2);
  assert.equal(result.parserVersion, 'mistral-ocr-4-1');
  assert.match(result.content, /--- Page 1 ---\n# First page/);
  assert.match(result.content, /--- Page 2 ---\n## Second page/);
});

test('surfaces authentication, rate limit, server, and malformed-response errors without leaking credentials', async () => {
  for (const [status, pattern] of [[401, /authentication/i], [403, /authentication/i], [429, /rate limit/i], [503, /temporarily unavailable/i]]) {
    await assert.rejects(runMistralOcrExtraction(Buffer.from('pdf'), {
      apiKey: 'do-not-leak',
      fetch: async () => new Response(JSON.stringify({ message: 'upstream detail' }), { status }),
    }), error => pattern.test(error.message) && !error.message.includes('do-not-leak'));
  }

  await assert.rejects(runMistralOcrExtraction(Buffer.from('pdf'), {
    apiKey: 'key', fetch: async () => new Response('{bad json', { status: 200 }),
  }), /invalid response/i);
  await assert.rejects(runMistralOcrExtraction(Buffer.from('pdf'), {
    apiKey: 'key', fetch: async () => new Response(JSON.stringify({ pages: [] }), { status: 200 }),
  }), /no readable pages/i);
});

test('requires an explicit key, supports cancellation, and rejects oversized source documents', async () => {
  await assert.rejects(runMistralOcrExtraction(Buffer.from('pdf'), {}), /API key is required/);
  await assert.rejects(runMistralOcrExtraction(Buffer.alloc(250 * 1024 * 1024 + 1), { apiKey: 'key' }), /250 MB/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runMistralOcrExtraction(Buffer.from('pdf'), {
    apiKey: 'key', signal: controller.signal,
  }), error => error.name === 'AbortError');
});
