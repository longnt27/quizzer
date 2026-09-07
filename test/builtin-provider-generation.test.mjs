import assert from 'node:assert/strict';
import test from 'node:test';
import { runAnthropic, runGemini, runOpenAI, runOpenAICompatible } from '../server/builtin-provider-generation.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string' } } };
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const input = { prompt: 'hello', schema, apiKey: 'secret', includeUsage: true, maxOutputTokens: 17 };

test('built-in runners map caps and preserve opt-in envelopes', async () => {
  const cases = [
    [runGemini, { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }, candidates: [{ content: { parts: [{ text: '{}' }] } }] }, 'maxOutputTokens'],
    [runOpenAI, { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }, output: [{ content: [{ type: 'output_text', text: '{}' }] }] }, 'max_output_tokens'],
    [runAnthropic, { usage: { input_tokens: 2, output_tokens: 3 }, content: [{ type: 'text', text: '{}' }] }, 'max_tokens'],
  ];
  for (const [runner, body, cap] of cases) {
    let sent;
    const result = await runner(input, undefined, async (_url, options) => { sent = JSON.parse(options.body); return response(body); });
    assert.equal(result.output, '{}'); assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 }); assert.equal(sent.generationConfig?.[cap] ?? sent[cap], 17);
    const legacy = await runner({ ...input, includeUsage: false }, undefined, async () => response(body)); assert.equal(legacy, '{}');
  }
  let sent;
  const result = await runOpenAICompatible(input, undefined, { label: 'Test', endpoint: 'https://example.test', defaultModel: 'x', jsonSchema: false, supportsImages: false }, async (_url, options) => { sent = JSON.parse(options.body); return response({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, choices: [{ message: { content: '{}' } }] }); });
  assert.equal(result.output, '{}'); assert.equal(result.usage.totalTokens, 5); assert.equal(sent.max_tokens, 17);
});

test('built-in runners bound, reject malformed responses, cancel, and sanitize provider errors', async () => {
  await assert.rejects(runGemini(input, undefined, async () => new Response('x'.repeat(16 * 1024 * 1024 + 1), { status: 200 })), /oversized/);
  await assert.rejects(runOpenAI(input, undefined, async () => new Response('{"x":1}', { status: 200, headers: { 'content-length': '99' } })), /truncated/);
  await assert.rejects(runAnthropic(input, undefined, async () => new Response('{', { status: 200 })), /malformed JSON/);
  await assert.rejects(runOpenAICompatible(input, undefined, { label: 'Test', endpoint: 'https://example.test', defaultModel: 'x' }, async () => new Response(JSON.stringify({ error: { message: 'secret' } }), { status: 401 })), error => error.status === 401 && !error.message.includes('secret'));
});

test('propagates mid-stream cancellation and cancels the response reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let reads = 0;
  const body = {
    getReader() {
      return {
        async read() {
          reads += 1;
          if (reads === 1) return { done: false, value: new Uint8Array([123]) };
          return new Promise(() => {});
        },
        cancel() { cancelled = true; },
        releaseLock() {},
      };
    },
  };
  const pending = runGemini(input, controller.signal, async () => ({
    status: 200, ok: true, headers: new Headers(), body,
  }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('validates runner inputs, caps, images, and provider defaults', async () => {
  const runners = [
    [runGemini, { apiKey: 'Gemini', model: undefined }],
    [runOpenAI, { apiKey: 'OpenAI', model: undefined }],
    [runAnthropic, { apiKey: 'Anthropic', model: undefined }],
  ];
  for (const [runner, extra] of runners) {
    await assert.rejects(runner({ ...input, ...extra, prompt: '' }), /prompt is invalid/);
    await assert.rejects(runner({ ...input, ...extra, schema: [] }), /schema is invalid/);
    await assert.rejects(runner({ ...input, ...extra, model: 42 }), /model is invalid/);
    await assert.rejects(runner({ ...input, ...extra, apiKey: ' ' }), /API key/);
    await assert.rejects(runner({ ...input, ...extra, maxOutputTokens: 0 }), /maxOutputTokens/);
    await assert.rejects(runner({ ...input, ...extra, maxOutputTokens: 10_000_001 }), /maxOutputTokens/);
  }
  await assert.rejects(runOpenAICompatible(input, undefined, { label: 'Test', endpoint: 'https://example.test', defaultModel: 'x' }, async () => response({ choices: [] })), /empty response/);
  await assert.rejects(runGemini({ ...input, images: ['not-data'] }, undefined, async () => response({})), /Invalid image/);
  await assert.rejects(runAnthropic({ ...input, images: ['data:text/plain;base64,QQ=='] }, undefined, async () => response({})), /Invalid image/);
  let sent;
  await runOpenAI({ ...input, model: undefined, images: ['data:image/png;base64,QQ=='] }, undefined, async (_url, options) => { sent = JSON.parse(options.body); return response({ output: [{ content: [{ type: 'output_text', text: '{}' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); });
  assert.equal(sent.input[0].content[1].type, 'input_image');
});

test('handles non-stream responses, redirects, status classes, and bounded headers', async () => {
  const config = { label: 'Custom', endpoint: 'https://example.test', defaultModel: 'x', jsonSchema: false, supportsImages: false };
  const nonStream = { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ choices: [{ message: { content: '{}' } }] }) };
  assert.equal((await runOpenAICompatible(input, undefined, config, async () => nonStream)).output, '{}');
  for (const status of [301, 401, 402, 403, 429, 500, 400]) {
    const result = new Response(JSON.stringify({ error: { message: 'do not leak' } }), { status, headers: { 'content-type': 'application/json' } });
    await assert.rejects(runOpenAICompatible(input, undefined, config, async () => result), error => {
      assert.equal(error.status, status === 301 ? 502 : status);
      assert.match(error.code, /provider_/);
      assert.doesNotMatch(error.message, /leak/);
      return true;
    });
  }
  await assert.rejects(runOpenAICompatible(input, undefined, config, async () => new Response('{}', { status: 200, headers: { 'content-length': 'abc' } })), /oversized/);
  await assert.rejects(runOpenAICompatible(input, undefined, config, async () => new Response('{}', { status: 200, headers: { 'content-length': String(16 * 1024 * 1024 + 1) } })), /oversized/);
  await assert.rejects(runOpenAICompatible(input, undefined, config, async () => new Response('{}', { status: 200, headers: { 'content-length': '100' } })), /truncated/);
});

test('supports image-capable compatible routes and usage failure/abort paths', async () => {
  const config = { label: 'Custom', endpoint: 'https://example.test', defaultModel: 'x', jsonSchema: true, supportsImages: true, providerRouting: true };
  let sent;
  const result = await runOpenAICompatible({ ...input, images: ['data:image/png;base64,QQ=='] }, undefined, config, async (_url, options) => { sent = JSON.parse(options.body); return response({ choices: [{ message: { content: '{}' } }] }); });
  assert.equal(result.output, '{}');
  assert.equal(sent.provider.require_parameters, true);
  assert.equal(sent.messages[0].content[1].type, 'image_url');
  const missingUsage = await runOpenAICompatible({ ...input, includeUsage: true }, undefined, config, async () => response({ choices: [{ message: { content: '{}' } }] }));
  assert.deepEqual(missingUsage.usage, { unknown: true, reason: 'missing' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runOpenAICompatible(input, controller.signal, config, async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new DOMException('The operation was aborted', 'AbortError');
  }), /aborted|AbortError/);
  const throwing = async () => { throw new TypeError('network down'); };
  await assert.rejects(runGemini(input, undefined, throwing), /network down/);
});
