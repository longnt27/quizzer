import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://vision.googleapis.com/v1/images:annotate';
const scopedPath = (context, relativePath) => {
  const root = resolve(String(context?.temporaryDirectory ?? ''));
  const target = resolve(root, String(relativePath ?? ''));
  if (!root || target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Image path escapes the plugin temporary directory');
  return target;
};

export const extractGoogleVisionText = payload => {
  const response = payload?.responses?.[0];
  if (response?.error?.message) throw new Error(`Google Cloud Vision: ${response.error.message}`);
  return String(response?.fullTextAnnotation?.text ?? response?.textAnnotations?.[0]?.description ?? '').replace(/\r\n?/g, '\n').trim();
};

export const handleRequest = async (request, fetchImpl = globalThis.fetch) => {
  const key = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (request.method === 'plugin.health') return { provider: 'google-cloud-vision', configured: Boolean(key) };
  if (request.method !== 'document.ocr') throw new Error(`Unsupported method: ${request.method}`);
  if (!key) throw new Error('GOOGLE_CLOUD_VISION_API_KEY is not configured');
  const imagePath = scopedPath(request.context, request.params?.image?.path);
  const content = (await readFile(imagePath)).toString('base64');
  const response = await fetchImpl(`${API}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google Cloud Vision request failed (${response.status}): ${String(payload?.error?.message ?? 'unknown error').slice(0, 1000)}`);
  return { text: extractGoogleVisionText(payload) };
};

const respond = (request, result, error) => process.stdout.write(`${JSON.stringify(error
  ? { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }
  : { jsonrpc: '2.0', id: request.id, result })}\n`);
const main = () => {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    process.stdin.pause();
    let request;
    try { request = JSON.parse(buffer.slice(0, newline)); }
    catch (error) { respond(undefined, undefined, error); return; }
    void handleRequest(request).then(result => respond(request, result)).catch(error => respond(request, undefined, error));
  });
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
