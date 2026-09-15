const ENDPOINT = 'https://api.mistral.ai/v1/ocr';
export const MISTRAL_OCR_MODEL = 'mistral-ocr-4-1';
const MAX_DOCUMENT_BYTES = 250 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 1_000_000;
const MAX_PAGE_MARKDOWN = 8 * 1024 * 1024;

const abortError = signal => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Mistral OCR extraction was cancelled'), { name: 'AbortError' });

const providerError = message => Object.assign(new Error(message), { code: 'provider_unavailable' });

const responseError = status => {
  if (status === 401 || status === 403) return providerError('Mistral OCR authentication failed. Check the configured API key.');
  if (status === 429) return providerError('Mistral OCR rate limit reached. Try again later or use a local extractor.');
  if (status >= 500) return providerError('Mistral OCR is temporarily unavailable. Try again later or use a local extractor.');
  return providerError(`Mistral OCR request failed with HTTP ${status}.`);
};

const readBoundedJson = async response => {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw providerError('Mistral OCR returned an oversized response.');
  let text;
  try { text = await response.text(); }
  catch { throw providerError('Mistral OCR returned an unreadable response.'); }
  if (text.length > MAX_RESPONSE_BYTES) throw providerError('Mistral OCR returned an oversized response.');
  try { return JSON.parse(text); }
  catch { throw providerError('Mistral OCR returned an invalid response.'); }
};

const normalizePages = payload => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.pages)
    || !payload.pages.length || payload.pages.length > MAX_PAGES) {
    throw providerError('Mistral OCR returned no readable pages.');
  }
  return payload.pages.map((page, index) => {
    if (!page || typeof page !== 'object' || typeof page.markdown !== 'string'
      || !page.markdown.trim() || page.markdown.length > MAX_PAGE_MARKDOWN) {
      throw providerError(`Mistral OCR returned invalid content for page ${index + 1}.`);
    }
    const pageIndex = Number.isSafeInteger(page.index) && page.index >= 0 ? page.index : index;
    return { number: pageIndex + 1, markdown: page.markdown.trim() };
  });
};

export const runMistralOcrExtraction = async (data, {
  apiKey,
  name = 'document.pdf',
  mimeType = 'application/pdf',
  signal,
  fetch = globalThis.fetch,
} = {}) => {
  if (signal?.aborted) throw abortError(signal);
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('Mistral OCR document must be binary');
  const source = Buffer.from(data);
  if (!source.length || source.length > MAX_DOCUMENT_BYTES) throw new Error('Mistral OCR document exceeds the 250 MB limit');
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw providerError('Mistral OCR API key is required.');
  if (typeof name !== 'string' || !name.trim() || name.length > 1024) throw new Error('Mistral OCR document name is invalid');
  if (typeof mimeType !== 'string' || !mimeType.trim() || mimeType.length > 255) throw new Error('Mistral OCR document MIME type is invalid');
  if (typeof fetch !== 'function') throw new Error('Mistral OCR fetch implementation is unavailable');

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MISTRAL_OCR_MODEL,
        document: {
          type: 'document_url',
          document_url: `data:${mimeType};base64,${source.toString('base64')}`,
        },
        include_image_base64: false,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError(signal);
    throw providerError(`Mistral OCR request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response?.ok) throw responseError(Number(response?.status) || 500);
  const pages = normalizePages(await readBoundedJson(response));
  return {
    content: pages.map(page => `--- Page ${page.number} ---\n${page.markdown}`).join('\n\n'),
    pageCount: pages.length,
    parserVersion: MISTRAL_OCR_MODEL,
    extractor: 'mistral-ocr',
  };
};
