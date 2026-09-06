const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

const validateTexts = texts => {
  if (!Array.isArray(texts) || !texts.length || texts.length > 250 || texts.some(text => typeof text !== 'string')) {
    throw new Error('texts must be an array of 1-250 strings');
  }
  return texts;
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
  if (typeof model !== 'string' || !model.trim()) throw new Error('An embedding model is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
    throw new Error('Embedding timeout must be from 1 ms to 30 minutes');
  }
  if (typeof fetchImplementation !== 'function') throw new Error('An HTTP fetch implementation is required');

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Embedding request timed out after ${timeoutMs} ms`)), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImplementation(embeddingEndpoint(host), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model: model.trim(), input: texts }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
      throw new Error(`Local embedding model ${model.trim()} is unavailable`);
    }
    return payload.embeddings;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
};

