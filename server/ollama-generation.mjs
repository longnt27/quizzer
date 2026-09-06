const DEFAULT_OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
const MAX_PROMPT_CHARACTERS = 2_000_000;
const MAX_SCHEMA_BYTES = 100_000;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const modelNamePattern = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/){0,4}[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const imagePattern = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

const providerError = (message, status = 503, code = 'provider_unavailable') => Object.assign(
  new Error(message), { status, code },
);

const ollamaEndpoint = path => {
  let url;
  try { url = new URL(path, process.env.OLLAMA_HOST || DEFAULT_OLLAMA_ORIGIN); }
  catch { throw new Error('OLLAMA_HOST must be a valid loopback URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('OLLAMA_HOST must be an unauthenticated HTTP loopback URL');
  return url;
};

export const validateOllamaModelName = value => {
  if (typeof value !== 'string' || !modelNamePattern.test(value.trim())) {
    throw new Error('Ollama model must be an installed model name such as qwen3:4b');
  }
  return value.trim();
};

const validateSchema = schema => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Ollama generation requires a JSON Schema object');
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) throw new Error('Ollama generation schema is too large');
  return serialized;
};

const decodeImages = images => {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error(`Ollama generation accepts at most ${MAX_IMAGES} source images`);
  let totalBytes = 0;
  return images.map(image => {
    const match = typeof image === 'string' ? imagePattern.exec(image) : undefined;
    if (!match) throw new Error('Invalid Ollama image input');
    const bytes = Buffer.byteLength(match[1], 'base64');
    totalBytes += bytes;
    if (totalBytes > MAX_IMAGE_BYTES) throw new Error('Ollama source images are too large');
    return match[1];
  });
};

const boundedResponseText = async response => {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw providerError('Ollama returned an oversized response');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw providerError('Ollama returned an oversized response');
  return text;
};

const parsePayload = async response => {
  const text = await boundedResponseText(response);
  try { return JSON.parse(text); }
  catch { throw providerError('Ollama returned invalid JSON'); }
};

const responseError = (payload, status) => {
  const message = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : `Ollama failed (${status})`;
  const code = status === 429 ? 'provider_limit' : status === 401 || status === 403 ? 'provider_auth' : 'provider_unavailable';
  return providerError(message, status, code);
};

export const runOllamaGeneration = async ({ prompt, schema, model, images = [] }, signal, fetchImpl = globalThis.fetch) => {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARACTERS) {
    throw new Error('Ollama generation prompt is invalid or too large');
  }
  const modelName = validateOllamaModelName(model);
  const serializedSchema = validateSchema(schema);
  const decodedImages = decodeImages(images);
  let response;
  try {
    response = await fetchImpl(ollamaEndpoint('/api/generate').href, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt: `${prompt}\n\nReturn only JSON matching this schema exactly:\n${serializedSchema}`,
        stream: false,
        format: schema,
        options: { temperature: 0 },
        ...(decodedImages.length ? { images: decodedImages } : {}),
      }),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    throw providerError(`Ollama is unavailable: ${error instanceof Error ? error.message : 'connection failed'}`);
  }
  const payload = await parsePayload(response);
  if (!response.ok) throw responseError(payload, response.status);
  if (payload?.done !== true || typeof payload.response !== 'string' || !payload.response.trim()) {
    throw providerError('Ollama returned no completed generation output');
  }
  return payload.response;
};

export const listOllamaModels = async (fetchImpl = globalThis.fetch, signal) => {
  let response;
  try {
    response = await fetchImpl(ollamaEndpoint('/api/tags').href, { signal });
  } catch (error) {
    if (error?.name === 'AbortError' && signal?.aborted) throw error;
    return { serverReady: false, models: [] };
  }
  if (!response.ok) return { serverReady: false, models: [] };
  let payload;
  try { payload = await parsePayload(response); }
  catch { return { serverReady: false, models: [] }; }
  if (!Array.isArray(payload?.models)) return { serverReady: false, models: [] };
  const models = payload.models.slice(0, 500).flatMap(item => {
    const name = typeof item?.name === 'string' ? item.name : item?.model;
    try {
      return [{
        name: validateOllamaModelName(name),
        model: typeof item?.model === 'string' ? item.model.slice(0, 300) : name,
        size: Number.isSafeInteger(item?.size) && item.size >= 0 ? item.size : 0,
        modifiedAt: typeof item?.modified_at === 'string' ? item.modified_at.slice(0, 100) : undefined,
        details: {
          family: typeof item?.details?.family === 'string' ? item.details.family.slice(0, 100) : undefined,
          parameterSize: typeof item?.details?.parameter_size === 'string' ? item.details.parameter_size.slice(0, 100) : undefined,
          quantization: typeof item?.details?.quantization_level === 'string' ? item.details.quantization_level.slice(0, 100) : undefined,
        },
      }];
    } catch { return []; }
  });
  return { serverReady: true, models };
};
