import { normalizeProviderUsage } from "./provider-usage.mjs";

export const DEFAULT_OPENAI_COMPATIBLE_ENDPOINT = "https://api.openai.com/v1";
const MAX_PROMPT_CHARACTERS = 2_000_000;
const MAX_SCHEMA_BYTES = 100_000;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_API_KEY_CHARACTERS = 16_384;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 10_000_000;

const imagePattern = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

export class ProviderError extends Error {
  constructor(message, status = 500, code = "provider_unavailable") {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
  }
}

export const providerError = (message, status = 500, code = "provider_unavailable") => (
  new ProviderError(message, status, code)
);

export const isLoopbackHost = hostname => {
  if (!hostname || typeof hostname !== "string") return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
};

export const validateOpenAICompatibleEndpoint = input => {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("OpenAI-compatible endpoint must be a non-empty string");
  }
  const raw = input.trim();
  if (/[\r\n\0\t]/.test(raw)) {
    throw new Error("OpenAI-compatible endpoint must not contain control characters or newlines");
  }
  if (raw.includes("\\")) {
    throw new Error("OpenAI-compatible endpoint must not contain backslashes");
  }
  if (/%2[fe]/i.test(raw) || /%5c/i.test(raw)) {
    throw new Error("OpenAI-compatible endpoint must not contain encoded path separators");
  }
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(raw)) {
    throw new Error("OpenAI-compatible endpoint must not contain path traversal segments");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OpenAI-compatible endpoint must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenAI-compatible endpoint protocol must be https: or http:");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Remote OpenAI-compatible endpoints require HTTPS; HTTP is only allowed for loopback addresses");
  }
  if (url.username || url.password) {
    throw new Error("OpenAI-compatible endpoint must not contain credentials (username or password)");
  }
  if (url.search) {
    throw new Error("OpenAI-compatible endpoint must not contain query parameters");
  }
  if (url.hash) {
    throw new Error("OpenAI-compatible endpoint must not contain a URL fragment");
  }
  const pathname = url.pathname;
  if (pathname.includes("//")) {
    throw new Error("OpenAI-compatible endpoint must not contain consecutive slashes");
  }
  const segments = pathname.split("/");
  if (segments.some(segment => segment === "." || segment === "..")) {
    throw new Error("OpenAI-compatible endpoint must not contain path traversal segments");
  }
  if (pathname.includes("%00")) {
    throw new Error("OpenAI-compatible endpoint must not contain null bytes");
  }
  const normalizedPath = pathname.replace(/\/+$/, "");
  return `${url.origin}${normalizedPath || ""}`;
};

export const resolveChatCompletionsUrl = baseEndpoint => {
  const validated = validateOpenAICompatibleEndpoint(baseEndpoint);
  const url = new URL(validated);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  const completionsPath = normalizedPath.endsWith("/chat/completions")
    ? normalizedPath
    : `${normalizedPath}/chat/completions`;
  return new URL(completionsPath, url.origin).href;
};

export const validateOpenAICompatibleModel = model => {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("OpenAI-compatible generation requires an explicit model");
  }
  if (/[\r\n\t\0]/.test(model)) {
    throw new Error("OpenAI-compatible model name must not contain control characters");
  }
  const trimmed = model.trim();
  if (trimmed.length > 200) {
    throw new Error("OpenAI-compatible model name must not exceed 200 characters");
  }
  return trimmed;
};

export const validateMaxOutputTokens = value => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS) {
    throw new Error(`maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}`);
  }
  return value;
};

const validateSchema = schema => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("OpenAI-compatible generation requires a JSON Schema object");
  }
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) {
    throw new Error("OpenAI-compatible generation schema is too large");
  }
  return serialized;
};

const validateImages = images => {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    throw new Error(`OpenAI-compatible generation accepts at most ${MAX_IMAGES} source images`);
  }
  let totalBytes = 0;
  return images.map(image => {
    const match = typeof image === "string" ? imagePattern.exec(image) : undefined;
    if (!match) throw new Error("Invalid OpenAI-compatible image input");
    const bytes = Buffer.byteLength(match[1], "base64");
    totalBytes += bytes;
    if (totalBytes > MAX_IMAGE_BYTES) {
      throw new Error("OpenAI-compatible source images are too large");
    }
    return image;
  });
};

const abortReason = signal => signal?.reason ?? Object.assign(new Error("OpenAI-compatible request was cancelled"), {
  name: "AbortError",
});

const withAbort = (promise, signal) => {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const responseContentLength = response => {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined || raw === "") return undefined;
  const normalized = String(raw).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw providerError("OpenAI-compatible provider returned an invalid Content-Length", 502, "provider_unavailable");
  }
  const length = Number(normalized);
  if (!Number.isSafeInteger(length)) {
    throw providerError("OpenAI-compatible provider returned an invalid Content-Length", 502, "provider_unavailable");
  }
  if (length > MAX_RESPONSE_BYTES) {
    throw providerError("OpenAI-compatible provider returned an oversized response", 502, "provider_unavailable");
  }
  return length;
};

export const boundedResponseText = async (response, signal) => {
  responseContentLength(response);
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await withAbort(reader.read(), signal);
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw providerError("OpenAI-compatible provider returned an invalid response stream", 502, "provider_unavailable");
        }
        received += value.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          throw providerError("OpenAI-compatible provider returned an oversized response", 502, "provider_unavailable");
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      try {
        const cancellation = reader.cancel(error);
        Promise.resolve(cancellation).catch(() => {});
      } catch { /* Ignore cancellation cleanup errors. */ }
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* The reader may still be cancelling. */ }
    }
    return Buffer.concat(chunks, received).toString("utf8");
  }

  if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await withAbort(response.arrayBuffer(), signal));
    if (buffer.length > MAX_RESPONSE_BYTES) {
      throw providerError("OpenAI-compatible provider returned an oversized response", 502, "provider_unavailable");
    }
    return buffer.toString("utf8");
  }

  throw providerError("OpenAI-compatible provider returned an unreadable response", 502, "provider_unavailable");
};

export const validateOpenAICompatibleApiKey = (apiKey, { required = false } = {}) => {
  const value = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!value) {
    if (required) {
      throw providerError("Enter an OpenAI-compatible API key in Quizzer", 401, "provider_auth");
    }
    return undefined;
  }
  if (value.length > MAX_API_KEY_CHARACTERS || /[^\x21-\x7e]/.test(value)) {
    throw providerError("OpenAI-compatible API key contains invalid characters", 401, "provider_auth");
  }
  return value;
};

const mapHttpStatusToCode = status => {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 402 || status === 429) return "provider_limit";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
};

const safeProviderMessage = (message, apiKey, fallback) => {
  if (typeof message !== "string" || !message.trim()) return fallback;
  const redacted = apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
  return redacted.replace(/[\r\n\t\0]+/g, " ").trim().slice(0, 2_000) || fallback;
};

export const runOpenAICompatibleGeneration = async ({
  prompt, schema, model, endpoint, apiKey, images = [], timeoutMs = DEFAULT_TIMEOUT_MS,
  includeUsage = false, maxOutputTokens,
}, signal, fetchImpl = globalThis.fetch) => {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARACTERS) {
    throw new Error("OpenAI-compatible generation prompt is invalid or too large");
  }
  const modelName = validateOpenAICompatibleModel(model);
  const serializedSchema = validateSchema(schema);
  const validatedImages = validateImages(images);
  const validatedMaxOutputTokens = validateMaxOutputTokens(maxOutputTokens);
  const completionsUrl = resolveChatCompletionsUrl(endpoint || DEFAULT_OPENAI_COMPATIBLE_ENDPOINT);
  const normalizedApiKey = validateOpenAICompatibleApiKey(apiKey, {
    required: !isLoopbackHost(new URL(completionsUrl).hostname),
  });

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  const effectiveTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => {
    controller.abort(Object.assign(new Error(`OpenAI-compatible request timed out after ${effectiveTimeout} ms`), {
      name: "TimeoutError",
    }));
  }, effectiveTimeout);

  const formattedPrompt = `${prompt}\n\nReturn JSON matching this schema exactly:\n${serializedSchema}`;
  const userContent = validatedImages.length
    ? [
        { type: "text", text: formattedPrompt },
        ...validatedImages.map(url => ({ type: "image_url", image_url: { url } })),
      ]
    : formattedPrompt;

  const requestHeaders = {
    "Content-Type": "application/json",
  };
  if (normalizedApiKey) {
    requestHeaders.Authorization = `Bearer ${normalizedApiKey}`;
  }

  const requestBody = JSON.stringify({
    model: modelName,
    messages: [{ role: "user", content: userContent }],
    response_format: { type: "json_object" },
    temperature: 0,
    ...(validatedMaxOutputTokens === undefined ? {} : { max_tokens: validatedMaxOutputTokens }),
  });

  try {
    const response = await withAbort(fetchImpl(completionsUrl, {
      method: "POST",
      signal: controller.signal,
      headers: requestHeaders,
      body: requestBody,
      redirect: "manual",
    }), controller.signal);

    if (response.status >= 300 && response.status < 400) {
      throw providerError(
        "OpenAI-compatible endpoint redirected, which is not permitted",
        502,
        "provider_unavailable",
      );
    }

    const text = await boundedResponseText(response, controller.signal);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        const code = mapHttpStatusToCode(response.status);
        throw providerError(
          `OpenAI-compatible provider failed (${response.status})`,
          response.status,
          code,
        );
      }
      throw providerError(
        "OpenAI-compatible provider returned invalid JSON response",
        502,
        "provider_unavailable",
      );
    }

    if (!response.ok) {
      const fallback = `OpenAI-compatible provider failed (${response.status})`;
      const message = safeProviderMessage(payload?.error?.message || payload?.message, normalizedApiKey, fallback);
      const code = mapHttpStatusToCode(response.status);
      throw providerError(message, response.status, code);
    }

    const refusal = payload?.choices?.[0]?.message?.refusal;
    if (typeof refusal === "string" && refusal.trim()) {
      throw providerError(
        `OpenAI-compatible provider refused request: ${safeProviderMessage(refusal, normalizedApiKey, "No reason supplied")}`,
        502,
        "provider_unavailable",
      );
    }

    const output = payload?.choices?.[0]?.message?.content;
    if (typeof output !== "string" || !output.trim()) {
      throw providerError(
        "OpenAI-compatible provider returned an empty or malformed completion response",
        502,
        "provider_unavailable",
      );
    }

    let candidateJson;
    try {
      const fenced = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      candidateJson = JSON.parse(fenced);
    } catch {
      try {
        candidateJson = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
      } catch {
        throw providerError(
          "OpenAI-compatible provider returned malformed non-JSON output",
          502,
          "provider_unavailable",
        );
      }
    }

    if (!candidateJson || typeof candidateJson !== "object" || Array.isArray(candidateJson)) {
      throw providerError(
        "OpenAI-compatible provider returned malformed non-JSON output",
        502,
        "provider_unavailable",
      );
    }

    const result = JSON.stringify(candidateJson);
    return includeUsage
      ? { output: result, usage: normalizeProviderUsage("openai-compatible", payload) }
      : result;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw providerError(
        reason instanceof Error ? reason.message : `OpenAI-compatible request timed out after ${effectiveTimeout} ms`,
        504,
        "provider_unavailable",
      );
    }
    if (error instanceof ProviderError) throw error;
    throw providerError(
      `OpenAI-compatible provider unavailable: ${error instanceof Error ? error.message : "connection failed"}`,
      503,
      "provider_unavailable",
    );
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener("abort", forwardAbort);
  }
};
