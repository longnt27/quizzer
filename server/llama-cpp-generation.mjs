import {
  runOpenAICompatibleGeneration,
  resolveChatCompletionsUrl,
  validateOpenAICompatibleEndpoint,
  validateOpenAICompatibleModel,
} from './openai-compatible-generation.mjs';

export const DEFAULT_LLAMA_CPP_ENDPOINT = 'http://127.0.0.1:8080/v1';
export const DEFAULT_LLAMA_CPP_MODEL = 'local-model';
const MAX_STATUS_BYTES = 256 * 1024;

const isNumericLoopbackHost = hostname => {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.slice(1).every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
};

const localEndpoint = input => {
  const endpoint = validateOpenAICompatibleEndpoint(input || DEFAULT_LLAMA_CPP_ENDPOINT);
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !isNumericLoopbackHost(url.hostname)) {
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
  const rawLength = response.headers?.get?.('content-length');
  const length = rawLength === null || rawLength === undefined || rawLength === '' ? undefined : Number(rawLength);
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new Error('llama.cpp status response has an invalid Content-Length');
  if (length !== undefined && length > MAX_STATUS_BYTES) throw new Error('llama.cpp status response is too large');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('llama.cpp status request was cancelled'), { name: 'AbortError' });
        const { done, value } = await new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => signal?.removeEventListener('abort', onAbort);
          const finish = (callback, value_) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value_);
          };
          const onAbort = () => {
            const reason = signal.reason ?? Object.assign(new Error('llama.cpp status request was cancelled'), { name: 'AbortError' });
            void reader.cancel(reason).catch(() => {});
            finish(reject, reason);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          reader.read().then(result => finish(resolve, result), error => finish(reject, error));
          if (signal?.aborted) onAbort();
        });
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
  if (length === undefined) throw new Error('llama.cpp status response has no bounded readable body');
  const text = await response.text();
  if (Buffer.byteLength(text) !== length) throw new Error('llama.cpp status response length did not match Content-Length');
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
