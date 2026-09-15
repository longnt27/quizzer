import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOcrProvider } from '../server/plugin-extraction.mjs';

const cloudPlugin = {
  id: 'dev.quizzer.cloud-ocr',
  version: '1.0.0',
  status: 'installed',
  enabled: true,
  compatible: true,
  capabilities: ['ocr'],
  permissions: {
    filesystem: ['scoped-temp', 'document-read'],
    secrets: ['GOOGLE_CLOUD_VISION_API_KEY'],
  },
  configuration: {
    type: 'object',
    additionalProperties: false,
    properties: {
      feature: { type: 'string', default: 'DOCUMENT_TEXT_DETECTION' },
      endpoint: { type: 'string', default: 'https://vision.googleapis.com/v1/images:annotate' },
    },
  },
};

const settings = {
  values: {
    'extraction.extractorPlugin': 'builtin',
    'extraction.ocrPlugin': cloudPlugin.id,
  },
};

test('preserves OCR manifest defaults and declared environment secrets alongside invocation contexts', async () => {
  let invocation;
  const manager = {
    list: async () => [cloudPlugin],
    invoke: async (...args) => {
      invocation = args;
      return { result: { text: 'Cloud OCR text' } };
    },
  };

  const route = await resolveOcrProvider(settings, {
    loadManager: async () => manager,
    loadInvocationContext: async () => ({}),
    environment: {
      GOOGLE_CLOUD_VISION_API_KEY: 'secret-key',
      UNDECLARED_SECRET: 'must-not-leak',
    },
  });

  assert.equal(await route.ocr(Buffer.from('png')), 'Cloud OCR text');
  assert.deepEqual(invocation[3].configuration, {
    feature: 'DOCUMENT_TEXT_DETECTION',
    endpoint: 'https://vision.googleapis.com/v1/images:annotate',
  });
  assert.deepEqual(invocation[3].secrets, { GOOGLE_CLOUD_VISION_API_KEY: 'secret-key' });
  assert.equal(JSON.stringify(invocation[3]).includes('must-not-leak'), false);
});
