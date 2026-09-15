import { validateOpenAICompatibleEndpoint } from './openai-compatible-generation.mjs';

const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const DEFAULT_OPENAI_EMBEDDINGS_ENDPOINT = 'https://api.openai.com/v1';
const DEFAULT_GEMINI_EMBEDDINGS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_DIMENSIONS = 8_192;
const MAX_TEXT_LENGTH = 100_000;
const MAX_TOTAL_TEXT_LENGTH = 2_000_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const validateTexts = texts => {
  if (!Array.isArray(texts) || !texts.length || texts.length > 250 || texts.some(text => typeof text !== 'string')) {
    throw new Error('texts must be an array of 1-250 strings');
  }
  if (texts.some(text => text.length > MAX_TEXT_LENGTH)) {
    throw new Error(`Embedding text is too large; maximum is ${MAX_TEXT_LENGTH} characters per text`);
  }
  if (texts.reduce((total, text) => total + text.length, 0) > MAX_TOTAL_TEXT_LENGTH) {
    throw new Error(`Embedding input is too large; maximum total size is ${MAX_TOTAL_TEXT_LENGTH} characters`);
  }
  return texts;
};

const validateModel = model => {
  if (typeof model !== 'string' || !model.trim()) throw new Error('An embedding model is required');
  return model.trim();
};

const validateTimeout = timeoutMs => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('Embedding timeout must be from 1 ms to 30 minutes');
  }
  return timeoutMs;
};

const validateFetch = fetchImplementation => {
  if (typeof fetchImplementation !== 'function') throw new Error('An HTTP fetch implementation is required');
  return fetchImplementation;
};

const validateVectors = (vectors, expected) => {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error(`Embedding provider returned ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${expected} texts`);
  }
  const dimensions = vectors[0]?.length;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS
    || vectors.some(vector => !Array.isArray(vector) || vector.length !== dimensions
      || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new Error('Embedding provider returned invalid or inconsistent vectors');
  }
  return vectors;
};

const withRequestSignal = async (signal, timeoutMs, run) => {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Embedding request timed out after ${timeoutMs} ms`)), timeoutMs);
  timer.unref?.();
  try { return await run(controller.signal); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
};

const responseTooLarge = () => new Error(`Embedding provider response is too large; limit is ${MAX_RESPONSE_BYTES} bytes`);

const ensureRequestActive = signal => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Embedding request cancelled');
};

const readBoundedJson = async (response, signal) => {
  const contentLength = response?.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) throw responseTooLarge();
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        ensureRequestActive(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('Embedding provider returned an invalid response body');
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw responseTooLarge();
        }
        chunks.push(value);
      }
      ensureRequestActive(signal);
      try { return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8')); }
      catch { return {}; }
    } finally {
      if (signal?.aborted) await reader.cancel(signal.reason).catch(() => {});
    }
  }

  // Lightweight injected fetch implementations used by callers/tests may expose only json().
  if (typeof response?.json === 'function') return response.json().catch(() => ({}));
  return {};
};

const isLoopbackHost = hostname => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.slice(1).every(value => /^\d{1,3}$/.test(value) && Number(value) <= 255);
};

export const isLoopbackEmbeddingEndpoint = endpoint => {
  try {
    const validated = validateOpenAICompatibleEndpoint(endpoint);
    const url = new URL(validated);
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch { return false; }
};

export const validateOpenAIEmbeddingEndpoint = endpoint => validateOpenAICompatibleEndpoint(endpoint);

export const resolveOpenAIEmbeddingsUrl = endpoint => {
  const validated = validateOpenAIEmbeddingEndpoint(endpoint);
  const url = new URL(validated);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path.endsWith('/embeddings') ? path : `${path}/embeddings`}`;
};

const embeddingEndpoint = host => {
  let url;
  try { url = new URL('/api/embed', host); }
  catch { throw new Error('OLLAMA_HOST must be a valid HTTP or HTTPS URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('OLLAMA_HOST must use HTTP or HTTPS');
  return url;
};

export const embedTextsWithOllama = async (texts, {
  model = 'all-minilm',
  host = process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST,
  timeoutMs = 10_000,
  signal,
  fetchImplementation = globalThis.fetch,
} = {}) => {
  validateTexts(texts);
  const resolvedModel = validateModel(model);
  validateTimeout(timeoutMs);
  validateFetch(fetchImplementation);

  return withRequestSignal(signal, timeoutMs, async requestSignal => {
    const response = await fetchImplementation(embeddingEndpoint(host), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: requestSignal,
      body: JSON.stringify({ model: resolvedModel, input: texts }),
    });
    const payload = await readBoundedJson(response, requestSignal);
    if (!response.ok || !Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
      throw new Error(`Local embedding model ${resolvedModel} is unavailable`);
    }
    return validateVectors(payload.embeddings, texts.length);
  });
};

export const embedTextsWithOpenAICompatible = async (texts, {
  model,
  endpoint = DEFAULT_OPENAI_EMBEDDINGS_ENDPOINT,
  apiKey,
  timeoutMs = 30_000,
  signal,
  fetchImplementation = globalThis.fetch,
} = {}) => {
  validateTexts(texts);
  const resolvedModel = validateModel(model);
  validateTimeout(timeoutMs);
  validateFetch(fetchImplementation);
  const url = resolveOpenAIEmbeddingsUrl(endpoint);

  return withRequestSignal(signal, timeoutMs, async requestSignal => {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof apiKey === 'string' && apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const response = await fetchImplementation(url, {
      method: 'POST', headers, signal: requestSignal,
      body: JSON.stringify({ model: resolvedModel, input: texts }),
    });
    const payload = await readBoundedJson(response, requestSignal);
    if (!response.ok) throw new Error(`Embedding provider rejected model ${resolvedModel}`);
    const vectors = Array.isArray(payload.data) ? payload.data.map(item => item?.embedding) : undefined;
    return validateVectors(vectors, texts.length);
  });
};

export const embedTextsWithOpenAI = async (texts, options = {}) => {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) throw new Error('OpenAI embedding API key is required');
  return embedTextsWithOpenAICompatible(texts, { ...options, endpoint: DEFAULT_OPENAI_EMBEDDINGS_ENDPOINT });
};

const normalizeGeminiModel = model => validateModel(model).replace(/^models\//, '');
const geminiText = (text, purpose) => purpose === 'query'
  ? `task: search result | query: ${text}`
  : `title: none | text: ${text}`;

export const embedTextsWithGemini = async (texts, {
  model = 'gemini-embedding-2',
  apiKey,
  outputDimensionality = 768,
  purpose = 'document',
  endpoint = DEFAULT_GEMINI_EMBEDDINGS_ENDPOINT,
  timeoutMs = 30_000,
  signal,
  fetchImplementation = globalThis.fetch,
} = {}) => {
  validateTexts(texts);
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Gemini embedding API key is required');
  if (!['document', 'query'].includes(purpose)) throw new Error('Embedding purpose must be document or query');
  if (!Number.isSafeInteger(outputDimensionality) || outputDimensionality < 128 || outputDimensionality > 3072) {
    throw new Error('Gemini embedding dimensionality must be between 128 and 3072');
  }
  const resolvedModel = normalizeGeminiModel(model);
  validateTimeout(timeoutMs);
  validateFetch(fetchImplementation);
  const base = validateOpenAIEmbeddingEndpoint(endpoint);
  const url = `${base}/models/${encodeURIComponent(resolvedModel)}:batchEmbedContents`;
  const modelResource = `models/${resolvedModel}`;
  const requests = texts.map(text => ({
    model: modelResource,
    content: { parts: [{ text: geminiText(text, purpose) }] },
    outputDimensionality,
  }));

  return withRequestSignal(signal, timeoutMs, async requestSignal => {
    const response = await fetchImplementation(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
      signal: requestSignal,
      body: JSON.stringify({ requests }),
    });
    const payload = await readBoundedJson(response, requestSignal);
    if (!response.ok) throw new Error(`Gemini embedding model ${resolvedModel} is unavailable`);
    const vectors = Array.isArray(payload.embeddings) ? payload.embeddings.map(item => item?.values) : undefined;
    return validateVectors(vectors, texts.length);
  });
};
