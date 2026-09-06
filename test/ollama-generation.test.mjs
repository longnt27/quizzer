import assert from 'node:assert/strict';
import test from 'node:test';
import { listOllamaModels, runOllamaGeneration, validateOllamaModelName } from '../server/ollama-generation.mjs';

const schema = { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array' } } };

test('uses Ollama structured output locally with bounded vision input', async () => {
  let request;
  const image = `data:image/png;base64,${Buffer.from('diagram').toString('base64')}`;
  const output = await runOllamaGeneration({
    prompt: 'Create one grounded question', schema, model: 'qwen3:4b', images: [image],
  }, undefined, async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ model: 'qwen3:4b', response: '{"questions":[]}', done: true }));
  });

  assert.equal(output, '{"questions":[]}');
  assert.equal(request.url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.body.model, 'qwen3:4b');
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.format, schema);
  assert.deepEqual(request.body.options, { temperature: 0 });
  assert.deepEqual(request.body.images, [Buffer.from('diagram').toString('base64')]);
  assert.match(request.body.prompt, /Return only JSON matching this schema exactly/);
});

test('requires a safe explicit Ollama model and bounded inputs', async () => {
  assert.equal(validateOllamaModelName('library/qwen3:4b'), 'library/qwen3:4b');
  for (const model of ['', '-flag', '../escape', 'library/../../escape', 'name with spaces', 'x'.repeat(400)]) {
    assert.throws(() => validateOllamaModelName(model), /Ollama model/);
  }
  await assert.rejects(runOllamaGeneration({ prompt: '', schema, model: 'qwen3:4b' }), /prompt is invalid/);
  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema: [], model: 'qwen3:4b' }), /JSON Schema object/);
  await assert.rejects(runOllamaGeneration({
    prompt: 'Prompt', schema, model: 'qwen3:4b', images: Array.from({ length: 7 }, () => 'data:image/png;base64,eA=='),
  }), /at most 6/);
  await assert.rejects(runOllamaGeneration({
    prompt: 'Prompt', schema, model: 'qwen3:4b', images: ['data:image/svg+xml;base64,PHN2Zz4='],
  }), /Invalid Ollama image/);
});

test('turns local runtime and model failures into resumable provider errors', async () => {
  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'qwen3:4b' }, undefined, async () => {
    throw new Error('connect ECONNREFUSED');
  }), error => error.code === 'provider_unavailable' && error.status === 503 && /ECONNREFUSED/.test(error.message));

  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'missing:latest' }, undefined, async () => (
    new Response(JSON.stringify({ error: 'model not found' }), { status: 404 })
  )), error => error.code === 'provider_unavailable' && error.status === 404 && error.message === 'model not found');

  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'qwen3:4b' }, undefined, async () => (
    new Response(JSON.stringify({ response: '{"questions":[]}', done: false }))
  )), error => error.code === 'provider_unavailable' && /no completed/.test(error.message));

  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'qwen3:4b' }, undefined, async () => (
    new Response('{broken')
  )), error => error.code === 'provider_unavailable' && /invalid JSON/.test(error.message));

  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'qwen3:4b' }, undefined, async () => (
    new Response('{}', { status: 429 })
  )), error => error.code === 'provider_limit' && error.status === 429 && /Ollama failed/.test(error.message));

  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'qwen3:4b' }, undefined, async () => (
    new Response('{}', { headers: { 'content-length': String(17 * 1024 * 1024) } })
  )), error => error.code === 'provider_unavailable' && /oversized/.test(error.message));
});

test('preserves request cancellation', async () => {
  const controller = new AbortController();
  const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'qwen3:4b' }, controller.signal, async (_url, options) => {
    controller.abort(aborted);
    throw options.signal.reason;
  }), error => error === aborted);
});

test('refuses non-loopback Ollama hosts so local privacy metadata remains truthful', async () => {
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = 'https://models.example.com';
  try {
    await assert.rejects(runOllamaGeneration({ prompt: 'Prompt', schema, model: 'qwen3:4b' }), error => (
      error.code === 'provider_unavailable' && /loopback URL/.test(error.message)
    ));
    assert.deepEqual(await listOllamaModels(), { serverReady: false, models: [] });
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
  }
});

test('lists installed Ollama models from the local tags endpoint and filters malformed entries', async () => {
  const status = await listOllamaModels(async url => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    return new Response(JSON.stringify({ models: [
      { name: 'qwen3:4b', model: 'qwen3:4b', size: 2_500_000_000, modified_at: '2026-01-02T03:04:05Z', details: {
        family: 'qwen3', parameter_size: '4.0B', quantization_level: 'Q4_K_M',
      } },
      { name: '../invalid', size: 10 },
    ] }));
  });
  assert.equal(status.serverReady, true);
  assert.deepEqual(status.models, [{
    name: 'qwen3:4b', model: 'qwen3:4b', size: 2_500_000_000, modifiedAt: '2026-01-02T03:04:05Z',
    details: { family: 'qwen3', parameterSize: '4.0B', quantization: 'Q4_K_M' },
  }]);
  assert.deepEqual(await listOllamaModels(async () => { throw new Error('offline'); }), { serverReady: false, models: [] });
  assert.deepEqual(await listOllamaModels(async () => new Response('not json')), { serverReady: false, models: [] });
  assert.deepEqual(await listOllamaModels(async () => new Response('{}', { status: 503 })), { serverReady: false, models: [] });
  assert.deepEqual(await listOllamaModels(async () => new Response('{}')), { serverReady: false, models: [] });

  const controller = new AbortController();
  const aborted = Object.assign(new Error('status cancelled'), { name: 'AbortError' });
  controller.abort(aborted);
  await assert.rejects(listOllamaModels(async () => { throw aborted; }, controller.signal), error => error === aborted);
});
