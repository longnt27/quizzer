import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const scopedPath = (context, relativePath) => {
  const root = resolve(String(context?.temporaryDirectory ?? ''));
  const target = resolve(root, String(relativePath ?? ''));
  if (!root || target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Image path escapes the plugin temporary directory');
  return target;
};
const amzTimestamp = date => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

export const signTextractRequest = ({ body, region, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) => {
  const service = 'textract';
  const host = `textract.${region}.amazonaws.com`;
  const amzDate = amzTimestamp(date);
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': 'Textract.DetectDocumentText',
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  return {
    url: `https://${host}/`,
    headers: {
      'Content-Type': headers['content-type'],
      Host: host,
      'X-Amz-Date': amzDate,
      'X-Amz-Target': headers['x-amz-target'],
      ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

export const extractTextractText = payload => (payload?.Blocks ?? [])
  .filter(block => block?.BlockType === 'LINE' && typeof block.Text === 'string')
  .map(block => block.Text.trim()).filter(Boolean).join('\n');

export const handleRequest = async (request, fetchImpl = globalThis.fetch, date = new Date()) => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const region = process.env.AWS_REGION || 'us-east-1';
  if (request.method === 'plugin.health') return { provider: 'aws-textract', region, configured: Boolean(accessKeyId && secretAccessKey) };
  if (request.method !== 'document.ocr') throw new Error(`Unsupported method: ${request.method}`);
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required');
  if (!/^[a-z0-9-]{3,32}$/.test(region)) throw new Error('AWS_REGION is invalid');
  const imagePath = scopedPath(request.context, request.params?.image?.path);
  const bytes = (await readFile(imagePath)).toString('base64');
  const body = JSON.stringify({ Document: { Bytes: bytes } });
  const signed = signTextractRequest({ body, region, accessKeyId, secretAccessKey, sessionToken, date });
  const response = await fetchImpl(signed.url, { method: 'POST', headers: signed.headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`AWS Textract request failed (${response.status}): ${String(payload?.message ?? payload?.Message ?? 'unknown error').slice(0, 1000)}`);
  return { text: extractTextractText(payload) };
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
