import {
  isLoopbackHost,
  runOpenAICompatibleGeneration,
  resolveChatCompletionsUrl,
  validateOpenAICompatibleEndpoint,
  validateOpenAICompatibleModel,
} from './openai-compatible-generation.mjs';

export const DEFAULT_LLAMA_CPP_ENDPOINT = 'http://127.0.0.1:8080/v1';
export const DEFAULT_LLAMA_CPP_MODEL = 'local-model';
const MAX_STATUS_BYTES = 256 * 1024;

const localEndpoint = input => {
  const endpoint = validateOpenAICompatibleEndpoint(input || DEFAULT_LLAMA_CPP_ENDPOINT);
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    throw new Error('llama.cpp endpoint must be an unauthenticated HTTP loopback URL');
  }
  return endpoint;
};

export const validateLlamaCppEndpoint = input => localEndpoint(input);
export const validateLlamaCppModel = input => validateOpenAICompatibleModel(input);

export const runLlamaCppGeneration = async (input, signal, fetchImpl = globalThis.fetch) => {
  const endpoint = localEndpoint(input?.endpoint);
  const model = validateLlamaCppModel(input?.model || DEFAULT_LLAMA_CPP_MODEL);
  return runOpenAICompatibleGeneration({ ...input, endpoint, model }, signal, fetchImpl);
};

const boundedStatusText = async (response, signal) => {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_STATUS_BYTES) throw new Error('llama.cpp status response is too large');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('llama.cpp status request was cancelled'), { name: 'AbortError' });
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('llama.cpp status response is invalid');
        size += value.byteLength;
        if (size > MAX_STATUS_BYTES) throw new Error('llama.cpp status response is too large');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size).toString('utf8');
    } catch (error) {
      try { await reader.cancel(error); } catch { /* Ignore cancellation cleanup errors. */ }
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* Ignore reader cleanup errors. */ }
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_STATUS_BYTES) throw new Error('llama.cpp status response is too large');
  return text;
};

const statusUrl = (endpoint, path) => {
  const url = new URL(endpoint);
  const base = url.pathname.replace(/\/+$/, '');
  return new URL(path === 'health' ? '/health' : `${base}/${path}`, url.origin).href;
};

export const getLlamaCppStatus = async ({ endpoint = DEFAULT_LLAMA_CPP_ENDPOINT } = {}, fetchImpl = globalThis.fetch, signal) => {
  let normalizedEndpoint;
  try { normalizedEndpoint = localEndpoint(endpoint); }
  catch (error) {
    return { configured: false, serverReady: false, models: [], capabilities: [], error: error instanceof Error ? error.message : 'Invalid llama.cpp endpoint' };
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error('llama.cpp health check timed out'), { name: 'TimeoutError' })), 3_000);
  timeout.unref?.();
  try {
    let health;
    try {
      health = await fetchImpl(statusUrl(normalizedEndpoint, 'health'), { signal: controller.signal, redirect: 'manual' });
    } catch (error) {
      if (error?.name === 'AbortError' && signal?.aborted) throw error;
      return { configured: true, serverReady: false, models: [], capabilities: [], error: 'llama.cpp server is unavailable' };
    }
    if (health.status >= 300 && health.status < 400) return { configured: true, serverReady: false, models: [], capabilities: [], error: 'llama.cpp health endpoint redirected' };
    let healthText;
    try { healthText = await boundedStatusText(health, controller.signal); }
    catch (error) {
      if (error?.name === 'AbortError' && signal?.aborted) throw error;
      return { configured: true, serverReady: false, models: [], capabilities: [], error: 'llama.cpp returned an invalid or oversized health response' };
    }
    if (!health.ok) return { configured: true, serverReady: false, models: [], capabilities: [], error: 'llama.cpp server is not ready' };
    let healthPayload;
    try { healthPayload = healthText ? JSON.parse(healthText) : {}; } catch { healthPayload = {}; }
    let models = [];
    try {
      const modelResponse = await fetchImpl(statusUrl(normalizedEndpoint, 'models'), { signal: controller.signal, redirect: 'manual' });
      if (modelResponse.ok) {
        const modelText = await boundedStatusText(modelResponse, controller.signal);
        const payload = JSON.parse(modelText);
        models = Array.isArray(payload?.data) ? payload.data.slice(0, 100).flatMap(item => {
          try { return [{ id: validateLlamaCppModel(item?.id) }]; } catch { return []; }
        }) : [];
      }
    } catch (error) {
      if (error?.name === 'AbortError' && signal?.aborted) throw error;
      // /v1/models is optional in older llama.cpp servers; health still counts as ready.
    }
    return {
      configured: true,
      serverReady: healthPayload?.status === 'loading' ? false : true,
      models,
      capabilities: ['generator', 'json-schema', 'cancellation'],
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
};

export const llamaCppCompletionsUrl = endpoint => resolveChatCompletionsUrl(localEndpoint(endpoint));
