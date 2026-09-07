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
