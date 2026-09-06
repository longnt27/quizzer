import assert from 'node:assert/strict';
import test from 'node:test';
import { generatorPluginAttachments, runGeneratorPlugin } from '../server/plugin-generation.mjs';

const plugin = {
  id: 'dev.quizzer.local-generator', status: 'installed', enabled: true, compatible: true,
  capabilities: ['generator'], permissions: { filesystem: ['scoped-temp'] },
};

test('routes generation through an installed local plugin with scoped image files', async () => {
  let invocation;
  const manager = {
    list: async () => [plugin],
    invoke: async (...args) => {
      invocation = args;
      return { result: { output: '{"questions":[]}' } };
    },
  };
  const image = `data:image/png;base64,${Buffer.from('image bytes').toString('base64')}`;
  const output = await runGeneratorPlugin({
    prompt: 'Create grounded questions', schema: { type: 'object' },
    model: plugin.id, images: [image],
  }, undefined, { loadManager: async () => manager });

  assert.equal(output, '{"questions":[]}');
  assert.equal(invocation[0], plugin.id);
  assert.equal(invocation[1], 'generation.generate');
  assert.deepEqual(invocation[2].images, [{ path: 'images/source-1.png', mimeType: 'image/png' }]);
  assert.equal(invocation[3].timeoutMs, 300_000);
  assert.deepEqual(invocation[3].files[0].data, Buffer.from('image bytes'));
});

test('validates generator plugin availability, permissions, inputs, and output envelope', async () => {
  const manager = overrides => ({
    list: async () => [{ ...plugin, ...overrides }],
    invoke: async () => ({ result: { output: '{"questions":[]}' } }),
  });
  const request = { prompt: 'Prompt', schema: {}, model: plugin.id, images: [] };

  await assert.rejects(runGeneratorPlugin({ ...request, model: '../escape' }, undefined, { loadManager: async () => manager() }), /plugin id is required/);
  await assert.rejects(runGeneratorPlugin(request, undefined, {}), /manager is unavailable/);
  for (const overrides of [{ enabled: false }, { compatible: false }, { capabilities: ['reranker'] }, { status: 'blocked' }]) {
    await assert.rejects(runGeneratorPlugin(request, undefined, { loadManager: async () => manager(overrides) }), /not installed, enabled, and compatible/);
  }
  await assert.rejects(runGeneratorPlugin({ ...request, images: ['invalid'] }, undefined, { loadManager: async () => manager() }), /unsupported image/);
  const image = `data:image/png;base64,${Buffer.from('image').toString('base64')}`;
  await assert.rejects(runGeneratorPlugin({ ...request, images: [image] }, undefined, {
    loadManager: async () => manager({ permissions: { filesystem: [] } }),
  }), /declare scoped-temp permission/);

  await assert.rejects(runGeneratorPlugin(request, undefined, { loadManager: async () => ({
    list: async () => [plugin], invoke: async () => { throw new Error('plugin crashed'); },
  }) }), error => error.code === 'provider_unavailable' && /plugin crashed/.test(error.message));
  for (const result of [undefined, {}, { output: '' }, { output: 42 }]) {
    await assert.rejects(runGeneratorPlugin(request, undefined, { loadManager: async () => ({
      list: async () => [plugin], invoke: async () => ({ result }),
    }) }), /invalid output envelope/);
  }
});

test('bounds generator image attachments', () => {
  const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
  assert.deepEqual(generatorPluginAttachments([]), []);
  assert.throws(() => generatorPluginAttachments({}), /array of at most 6/);
  assert.throws(() => generatorPluginAttachments(Array.from({ length: 7 }, () => png)), /array of at most 6/);
  assert.throws(() => generatorPluginAttachments(['data:image/svg+xml;base64,PHN2Zz4=']), /unsupported image/);
});

