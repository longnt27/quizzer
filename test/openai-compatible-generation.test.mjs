import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPENAI_COMPATIBLE_ENDPOINT,
  resolveChatCompletionsUrl,
  runOpenAICompatibleGeneration,
  validateOpenAICompatibleEndpoint,
  validateOpenAICompatibleModel,
} from "../server/openai-compatible-generation.mjs";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: { questions: { type: "array" } },
};

const remoteParams = (overrides = {}) => ({
  prompt: "test",
  schema,
  model: "gpt-4o",
  endpoint: "https://api.example.com/v1",
  apiKey: "sk-test-key",
  ...overrides,
});

test("validates OpenAI-compatible endpoints according to security policy", () => {
  // Loopback HTTP allowed
  assert.equal(validateOpenAICompatibleEndpoint("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(validateOpenAICompatibleEndpoint("http://localhost:8000/v1"), "http://localhost:8000/v1");
  assert.equal(validateOpenAICompatibleEndpoint("http://[::1]:8080/v1"), "http://[::1]:8080/v1");
  assert.equal(validateOpenAICompatibleEndpoint("http://127.0.0.2:5000/v1/"), "http://127.0.0.2:5000/v1");
  assert.equal(validateOpenAICompatibleEndpoint("http://127.255.255.255:1234"), "http://127.255.255.255:1234");

  // Remote HTTPS allowed
  assert.equal(validateOpenAICompatibleEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1");
  assert.equal(validateOpenAICompatibleEndpoint("https://api.example.com/v1/chat"), "https://api.example.com/v1/chat");
  assert.throws(() => validateOpenAICompatibleEndpoint(""), /non-empty string/);
  assert.throws(() => validateOpenAICompatibleEndpoint(undefined), /non-empty string/);

  // Trailing slash normalization
  assert.equal(validateOpenAICompatibleEndpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1///"), /consecutive slashes/);

  // Remote HTTP rejected
  assert.throws(() => validateOpenAICompatibleEndpoint("http://api.openai.com/v1"), /require HTTPS/i);
  assert.throws(() => validateOpenAICompatibleEndpoint("http://192.168.1.100:8000/v1"), /require HTTPS/i);
  assert.throws(() => validateOpenAICompatibleEndpoint("http://10.0.0.1:8000/v1"), /require HTTPS/i);
  assert.throws(() => validateOpenAICompatibleEndpoint("ftp://api.openai.com/v1"), /protocol must be https: or http:/i);

  // Credentials / userinfo rejected
  assert.throws(() => validateOpenAICompatibleEndpoint("https://user:pass@api.openai.com/v1"), /must not contain credentials/);
  assert.throws(() => validateOpenAICompatibleEndpoint("http://user@localhost:8000/v1"), /must not contain credentials/);

  // Query and fragment rejected
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1?query=1"), /query/i);
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1#hash"), /fragment/i);

  // Traversal, redundant slashes, and encoded separators rejected
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1/../v2"), /traversal/i);
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1/./v2"), /traversal/i);
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com//v1"), /consecutive slashes/i);
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1%2Fextra"), /encoded path separators/);
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1%5Cextra"), /encoded path separators/);
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1\\\\extra"), /backslashes/);
  assert.throws(() => validateOpenAICompatibleEndpoint("https://api.openai.com/v1%00"), /null bytes/);
  assert.throws(() => validateOpenAICompatibleEndpoint("not-a-url"), /valid URL/i);
});

test("resolves chat completions URL accurately", () => {
  assert.equal(
    resolveChatCompletionsUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    resolveChatCompletionsUrl("https://api.openai.com/v1/"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    resolveChatCompletionsUrl("http://localhost:8000"),
    "http://localhost:8000/chat/completions"
  );
  assert.equal(
    resolveChatCompletionsUrl("http://127.0.0.1:11434/v1"),
    "http://127.0.0.1:11434/v1/chat/completions"
  );
});

test("validates explicit OpenAI-compatible model names", () => {
  assert.equal(validateOpenAICompatibleModel("gpt-4o"), "gpt-4o");
  assert.equal(validateOpenAICompatibleModel("  meta-llama/Llama-3-70b-instruct  "), "meta-llama/Llama-3-70b-instruct");
  assert.equal(validateOpenAICompatibleModel("custom-model:v1"), "custom-model:v1");

  assert.throws(() => validateOpenAICompatibleModel(""), /explicit model/i);
  assert.throws(() => validateOpenAICompatibleModel("   "), /explicit model/i);
  assert.throws(() => validateOpenAICompatibleModel(null), /explicit model/i);
  assert.throws(() => validateOpenAICompatibleModel("a".repeat(201)), /must not exceed 200 characters/);
  assert.throws(() => validateOpenAICompatibleModel("gpt-4o\n"), /control characters/);
  assert.throws(() => validateOpenAICompatibleModel("gpt-4o\r"), /control characters/);
});

test("executes generation with structured JSON format and handles credentials", async () => {
  let capturedRequest;
  const image = `data:image/png;base64,${Buffer.from("test-diagram").toString("base64")}`;

  const output = await runOpenAICompatibleGeneration({
    prompt: "Generate a quiz question",
    schema,
    model: "gpt-4o-mini",
    endpoint: "https://api.openai.com/v1",
    apiKey: "sk-test-12345",
    images: [image],
  }, undefined, async (url, options) => {
    capturedRequest = {
      url,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(JSON.stringify({
      id: "chatcmpl-1",
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({ questions: [{ question: "What is 2+2?" }] }),
        },
        finish_reason: "stop",
      }],
    }));
  });

  assert.deepEqual(JSON.parse(output), { questions: [{ question: "What is 2+2?" }] });
  assert.equal(capturedRequest.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.headers.Authorization, "Bearer sk-test-12345");
  assert.equal(capturedRequest.headers["Content-Type"], "application/json");
  assert.equal(capturedRequest.body.model, "gpt-4o-mini");
  assert.deepEqual(capturedRequest.body.response_format, { type: "json_object" });
  assert.equal(capturedRequest.body.temperature, 0);

  // Messages check
  const messages = capturedRequest.body.messages;
  assert.equal(messages[0].role, "user");
  assert.ok(Array.isArray(messages[0].content));
  assert.equal(messages[0].content[0].type, "text");
  assert.match(messages[0].content[0].text, /Return JSON matching this schema exactly/);
  assert.equal(messages[0].content[1].type, "image_url");
  assert.equal(messages[0].content[1].image_url.url, image);
});

test("allows loopback endpoints without API key", async () => {
  let capturedHeaders;
  const output = await runOpenAICompatibleGeneration({
    prompt: "Generate question",
    schema,
    model: "local-model",
    endpoint: "http://127.0.0.1:8000/v1",
  }, undefined, async (url, options) => {
    capturedHeaders = options.headers;
    return new Response(JSON.stringify({
      choices: [{
        message: { role: "assistant", content: JSON.stringify({ questions: [] }) },
      }],
    }));
  });

  assert.equal(output, JSON.stringify({ questions: [] }));
  assert.equal(capturedHeaders.Authorization, undefined);
});

test("bounds request inputs (prompt, schema, images)", async () => {
  await assert.rejects(
    runOpenAICompatibleGeneration({ prompt: "", schema, model: "gpt-4o" }),
    /prompt is invalid/
  );
  await assert.rejects(
    runOpenAICompatibleGeneration({ prompt: "a".repeat(2_000_001), schema, model: "gpt-4o" }),
    /prompt is invalid or too large/
  );
  await assert.rejects(
    runOpenAICompatibleGeneration({ prompt: "test", schema: null, model: "gpt-4o" }),
    /JSON Schema object/
  );
  await assert.rejects(
    runOpenAICompatibleGeneration({
      prompt: "test",
      schema,
      model: "gpt-4o",
      images: Array.from({ length: 7 }, () => "data:image/png;base64,eA=="),
    }),
    /at most 6/
  );
  await assert.rejects(
    runOpenAICompatibleGeneration({
      prompt: "test",
      schema,
      model: "gpt-4o",
      images: ["data:image/svg+xml;base64,PHN2Zz4="],
    }),
    /Invalid OpenAI-compatible image/
  );
});

test("bounds response sizes and rejects redirects", async () => {
  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response("{}", { headers: { "content-length": String(17 * 1024 * 1024) } })
    )),
    error => error.code === "provider_unavailable" && /oversized/.test(error.message)
  );

  for (const status of [301, 302, 307, 308]) {
    await assert.rejects(
      runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
        new Response("", { status, headers: { location: "https://redirected.example.com" } })
      )),
      error => error.code === "provider_unavailable" && /redirected/i.test(error.message)
    );
  }

  for (const contentLength of ["-1", "1.5", "not-a-number"]) {
    await assert.rejects(
      runOpenAICompatibleGeneration(remoteParams(), undefined, async () => ({
        status: 200,
        ok: true,
        headers: { get: name => name === "content-length" ? contentLength : null },
        arrayBuffer: async () => Buffer.from("{}"),
      })),
      error => error.code === "provider_unavailable" && /invalid Content-Length/.test(error.message),
    );
  }

  const oversizedChunk = new Uint8Array(8 * 1024 * 1024 + 1);
  let reads = 0;
  let cancelled = false;
  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => ({
        read: async () => reads++ < 2 ? { done: false, value: oversizedChunk } : { done: true },
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }) },
    })),
    error => error.code === "provider_unavailable" && /oversized/.test(error.message),
  );
  assert.equal(cancelled, true);
});

test("keeps cancellation and timeout active while consuming the response body", async () => {
  const controller = new AbortController();
  const abortedError = Object.assign(new Error("aborted generation"), { name: "AbortError" });
  let cancelCalled = false;

  const cancellation = runOpenAICompatibleGeneration(
    remoteParams({ timeoutMs: 5_000 }),
    controller.signal,
    async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => { cancelCalled = true; },
        releaseLock: () => {},
      }) },
    }),
  );
  setTimeout(() => controller.abort(abortedError), 10);
  await assert.rejects(cancellation, error => error === abortedError);
  assert.equal(cancelCalled, true);

  let timeoutCancelCalled = false;
  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams({ timeoutMs: 20 }), undefined, async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => { timeoutCancelCalled = true; },
        releaseLock: () => {},
      }) },
    })),
    error => error.code === "provider_unavailable"
      && error.status === 504
      && /timed out after 20 ms/.test(error.message),
  );
  assert.equal(timeoutCancelCalled, true);
});

test("requires safe credentials for remote endpoints without exposing them", async () => {
  let fetchCalled = false;
  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams({ apiKey: undefined }), undefined, async () => {
      fetchCalled = true;
    }),
    error => error.code === "provider_auth" && error.status === 401 && !error.message.includes("sk-"),
  );
  assert.equal(fetchCalled, false);

  for (const apiKey of ["bad\nkey", "bad\rkey", "bad\0key", "x".repeat(16_385)]) {
    await assert.rejects(
      runOpenAICompatibleGeneration(remoteParams({ apiKey }), undefined, async () => {
        fetchCalled = true;
      }),
      error => error.code === "provider_auth" && !error.message.includes(apiKey),
    );
  }
});

test("maps auth, quota, availability, and malformed responses into failover error codes", async () => {
  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 })
    )),
    error => error.code === "provider_auth" && error.status === 401 && /Invalid API key/.test(error.message)
  );

  const secret = "sk-never-persist-this-value";
  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams({ apiKey: secret }), undefined, async () => (
      new Response(JSON.stringify({ error: { message: `Rejected credential ${secret}\nretry later` } }), { status: 401 })
    )),
    error => error.code === "provider_auth"
      && !error.message.includes(secret)
      && !error.message.includes("\n")
      && /\[redacted\]/.test(error.message),
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ error: { message: "Forbidden access" } }), { status: 403 })
    )),
    error => error.code === "provider_auth" && error.status === 403
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 })
    )),
    error => error.code === "provider_limit" && error.status === 429
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ error: { message: "Insufficient quota" } }), { status: 402 })
    )),
    error => error.code === "provider_limit" && error.status === 402
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ error: { message: "Server overloaded" } }), { status: 503 })
    )),
    error => error.code === "provider_unavailable" && error.status === 503
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    }),
    error => error.code === "provider_unavailable" && error.status === 503 && /ECONNREFUSED/.test(error.message)
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response("<html>Bad gateway</html>", { status: 200 })
    )),
    error => error.code === "provider_unavailable" && error.status === 502 && /invalid JSON/i.test(error.message)
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ choices: [] }), { status: 200 })
    )),
    error => error.code === "provider_unavailable" && error.status === 502 && /empty or malformed/.test(error.message)
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", refusal: "Cannot process request" } }],
      }), { status: 200 })
    )),
    error => error.code === "provider_unavailable" && error.status === 502 && /refused/i.test(error.message)
  );

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "I cannot do that as JSON." } }],
      }), { status: 200 })
    )),
    error => error.code === "provider_unavailable" && error.status === 502 && /non-JSON/i.test(error.message)
  );
});

test("normalizes fenced and prose-wrapped JSON and rejects array roots", async () => {
  for (const content of [
    '```json\n{"questions":[]}\n```',
    'Here is the result: {"questions":[]} Done.',
  ]) {
    const output = await runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ choices: [{ message: { content } }] }))
    ));
    assert.equal(output, '{"questions":[]}');
  }

  await assert.rejects(
    runOpenAICompatibleGeneration(remoteParams(), undefined, async () => (
      new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }))
    )),
    error => error.code === "provider_unavailable" && /non-JSON/.test(error.message),
  );
});
