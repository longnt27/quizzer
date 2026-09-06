import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveDocumentExtractor, resolveOcrProvider, validatePluginExtraction, validatePluginOcr,
} from '../server/plugin-extraction.mjs';

const extractorPlugin = {
  id: 'dev.quizzer.extractor', version: '1.2.3', status: 'installed', enabled: true, compatible: true,
  capabilities: ['extractor'], permissions: { filesystem: ['scoped-temp', 'document-read'] },
};
const ocrPlugin = {
  id: 'dev.quizzer.ocr', version: '2.0.0', status: 'installed', enabled: true, compatible: true,
  capabilities: ['ocr'], permissions: { filesystem: ['scoped-temp', 'document-read'] },
};
const settings = (extractor = extractorPlugin.id, ocr = ocrPlugin.id) => ({ values: {
  'extraction.extractorPlugin': extractor,
  'extraction.ocrPlugin': ocr,
} });

test('routes extraction through an installed plugin with a bounded scoped document', async () => {
  let invocation;
  const imageData = Buffer.from('image bytes').toString('base64');
  const manager = {
    list: async () => [extractorPlugin],
    invoke: async (...args) => {
      invocation = args;
      return { result: {
        content: '# Extracted\n\nTerraform state.',
        pageCount: 2,
        parserVersion: 'marker-4',
        images: [{ name: 'diagram.png', mimeType: 'image/png', data: imageData, page: 2 }],
      } };
    },
  };
  const route = await resolveDocumentExtractor(settings(), { loadManager: async () => manager });
  const signal = new AbortController().signal;
  const extracted = await route.extract(Buffer.from('source PDF'), {
    name: 'Guide.pdf', mimeType: 'application/pdf', signal,
  });

  assert.equal(route.identity, 'plugin:dev.quizzer.extractor@1.2.3');
  assert.equal(extracted.parserVersion, 'plugin:dev.quizzer.extractor@1.2.3/marker-4');
  assert.equal(extracted.images[0].data, imageData);
  assert.equal(invocation[0], extractorPlugin.id);
  assert.equal(invocation[1], 'document.extract');
  assert.deepEqual(invocation[2].document, {
    path: 'input/document.pdf', name: 'Guide.pdf', mimeType: 'application/pdf', size: 10,
  });
  assert.equal(invocation[3].signal, signal);
  assert.equal(invocation[3].timeoutMs, 600_000);
  assert.equal(invocation[3].fileLimits.maximumFileBytes, 250 * 1024 * 1024);
  assert.deepEqual(invocation[3].files[0].data, Buffer.from('source PDF'));
});

test('routes OCR through an installed plugin and validates its text envelope', async () => {
  let invocation;
  const manager = {
    list: async () => [ocrPlugin],
    invoke: async (...args) => {
      invocation = args;
      return { result: { text: 'State locking diagram' } };
    },
  };
  const route = await resolveOcrProvider(settings(), { loadManager: async () => manager });
  const text = await route.ocr(Buffer.from('png'), { name: 'state.png', mimeType: 'image/png' });

  assert.equal(route.identity, 'plugin:dev.quizzer.ocr@2.0.0');
  assert.equal(text, 'State locking diagram');
  assert.equal(invocation[0], ocrPlugin.id);
  assert.equal(invocation[1], 'document.ocr');
  assert.deepEqual(invocation[2].image, {
    path: 'input/image.png', name: 'state.png', mimeType: 'image/png', size: 3,
  });
});

test('keeps built-in extraction and OCR routes independent of the plugin manager', async () => {
  const builtin = async () => 'built-in OCR';
  const extractor = await resolveDocumentExtractor(settings('builtin', 'builtin'));
  const ocr = await resolveOcrProvider(settings('builtin', 'builtin'), { builtin });
  assert.deepEqual(extractor, { component: 'builtin', identity: 'builtin', extract: undefined });
  assert.equal(ocr.component, 'builtin');
  assert.equal(ocr.ocr, builtin);
});

test('rejects unavailable, under-permissioned, failed, and cancelled extraction plugins', async () => {
  const resolve = overrides => resolveDocumentExtractor(settings(), { loadManager: async () => ({
    list: async () => [{ ...extractorPlugin, ...overrides }],
    invoke: async () => ({ result: { content: 'valid' } }),
  }) });
  for (const overrides of [
    { enabled: false }, { compatible: false }, { status: 'blocked' }, { capabilities: ['ocr'] },
    { permissions: { filesystem: ['scoped-temp'] } },
  ]) {
    await assert.rejects(resolve(overrides), error => error.code === 'provider_unavailable');
  }
  await assert.rejects(resolveDocumentExtractor(settings(), { loadManager: async () => ({ list: async () => [] }) }), /not installed/);
  await assert.rejects(resolveDocumentExtractor(settings('../escape'), {}), /not configured correctly/);

  const failed = await resolveDocumentExtractor(settings(), { loadManager: async () => ({
    list: async () => [extractorPlugin], invoke: async () => { throw new Error('plugin crashed'); },
  }) });
  await assert.rejects(failed.extract(Buffer.from('source')), error => error.code === 'provider_unavailable' && /plugin crashed/.test(error.message));

  const cancelled = await resolveDocumentExtractor(settings(), { loadManager: async () => ({
    list: async () => [extractorPlugin], invoke: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  }) });
  await assert.rejects(cancelled.extract(Buffer.from('source')), error => error.name === 'AbortError');

  await assert.rejects(failed.extract('not binary'), /must be binary/);
  await assert.rejects(failed.extract(Buffer.alloc(0)), /250 MB limit/);
  await assert.rejects(failed.extract(Buffer.from('x'), { name: '' }), /document name/);

  const unsafe = await resolveDocumentExtractor(settings(), { loadManager: async () => ({
    list: async () => [extractorPlugin], invoke: async () => ({ result: { content: '' } }),
  }) });
  await assert.rejects(unsafe.extract(Buffer.from('source')), error => error.code === 'provider_unavailable' && /unsafe output/.test(error.message));
});

test('bounds extractor and OCR inputs and output schemas', async () => {
  assert.throws(() => validatePluginExtraction(undefined, extractorPlugin), /invalid result envelope/);
  assert.throws(() => validatePluginExtraction({ content: '' }, extractorPlugin), /non-empty bounded/);
  assert.throws(() => validatePluginExtraction({ content: 'x', pageCount: 0 }, extractorPlugin), /page count/);
  assert.throws(() => validatePluginExtraction({ content: 'x', images: {} }, extractorPlugin), /array of at most/);
  assert.throws(() => validatePluginExtraction({
    content: 'x', images: [{ name: 'bad.svg', mimeType: 'image/svg+xml', data: 'eA==' }],
  }, extractorPlugin), /unsupported MIME/);
  assert.throws(() => validatePluginExtraction({ content: 'x', images: [null] }, extractorPlugin), /image 1 is invalid/);
  assert.throws(() => validatePluginExtraction({
    content: 'x', images: [{ name: 'bad.png', mimeType: 'image/png', data: '*' }],
  }, extractorPlugin), /invalid base64/);
  assert.throws(() => validatePluginExtraction({
    content: 'x', images: [{ name: 'empty.png', mimeType: 'image/png', data: '' }],
  }, extractorPlugin), /bounded image size/);
  assert.throws(() => validatePluginExtraction({
    content: 'x', images: [{ name: 'page.png', mimeType: 'image/png', data: 'eA==', page: 0 }],
  }, extractorPlugin), /invalid page/);
  assert.throws(() => validatePluginExtraction({
    content: 'x', images: [{ name: 'offset.png', mimeType: 'image/png', data: 'eA==', sourceStart: -1 }],
  }, extractorPlugin), /invalid sourceStart/);
  assert.throws(() => validatePluginOcr(null), /invalid result envelope/);
  assert.equal(validatePluginOcr({}), '');

  const ocr = await resolveOcrProvider(settings(), { loadManager: async () => ({
    list: async () => [ocrPlugin], invoke: async () => ({ result: { text: 'ok' } }),
  }) });
  await assert.rejects(ocr.ocr(Buffer.alloc(0)), /bounded image size/);
  await assert.rejects(ocr.ocr(Buffer.from('x'), { mimeType: 'image/svg+xml' }), /unsupported MIME/);

  const failedOcr = await resolveOcrProvider(settings(), { loadManager: async () => ({
    list: async () => [ocrPlugin], invoke: async () => { throw new Error('OCR crashed'); },
  }) });
  await assert.rejects(failedOcr.ocr(Buffer.from('x')), error => error.code === 'provider_unavailable' && /OCR crashed/.test(error.message));
  const unsafeOcr = await resolveOcrProvider(settings(), { loadManager: async () => ({
    list: async () => [ocrPlugin], invoke: async () => ({ result: [] }),
  }) });
  await assert.rejects(unsafeOcr.ocr(Buffer.from('x')), error => error.code === 'provider_unavailable' && /unsafe output/.test(error.message));
  const cancelledOcr = await resolveOcrProvider(settings(), { loadManager: async () => ({
    list: async () => [ocrPlugin], invoke: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  }) });
  await assert.rejects(cancelledOcr.ocr(Buffer.from('x')), error => error.name === 'AbortError');
});
