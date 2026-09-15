import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const normalizeText = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();

const scopedPath = (context, relativePath) => {
  const root = resolve(String(context?.temporaryDirectory ?? ''));
  const target = resolve(root, String(relativePath ?? ''));
  if (!root || target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Image path escapes the plugin temporary directory');
  return target;
};

const run = (command, args, timeoutMs = 60_000) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-64_000); });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => {
    clearTimeout(timer);
    if (code === 0) resolvePromise(stdout);
    else reject(new Error(stderr.trim() || `tesseract exited with code ${code}`));
  });
});

export const handleRequest = async request => {
  if (request.method === 'plugin.health') {
    const version = normalizeText(await run('tesseract', ['--version'], 5_000));
    return { engine: 'tesseract', version: version.split('\n')[0] || 'available' };
  }
  if (request.method !== 'document.ocr') throw new Error(`Unsupported method: ${request.method}`);
  const imagePath = scopedPath(request.context, request.params?.image?.path);
  const language = request.context?.configuration?.language || 'eng';
  if (!/^[A-Za-z0-9_+.-]{1,80}$/.test(language)) throw new Error('Tesseract language is invalid');
  const text = await run('tesseract', [imagePath, 'stdout', '-l', language, '--psm', '3']);
  return { text: normalizeText(text) };
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
    const line = buffer.slice(0, newline).trim();
    process.stdin.pause();
    let request;
    try { request = JSON.parse(line); }
    catch (error) { respond(undefined, undefined, error); return; }
    void handleRequest(request).then(result => respond(request, result)).catch(error => respond(request, undefined, error));
  });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
