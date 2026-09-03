import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.QUIZZER_SERVICE_PORT || 8787);
const maxBodyBytes = 25 * 1024 * 1024;
const managedMarkerDirectory = join(process.cwd(), '.quizzer-tools', 'marker');
const managedMarkerExecutable = join(managedMarkerDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'marker_single.exe' : 'marker_single');
const integrationJobs = {
  marker: { state: 'idle', message: '' },
  codex: { state: 'idle', message: '' },
};
let systemMarkerDetected;

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:5173' });
  response.end(JSON.stringify(body));
};

const readJson = request => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', chunk => {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) reject(new Error('Request is too large'));
  });
  request.on('end', () => {
    try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON request')); }
  });
  request.on('error', reject);
});

const decodeImage = (dataUrl, index) => {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Invalid image input');
  const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
  return { path: `source-${index}.${extension}`, data: Buffer.from(match[2], 'base64') };
};

const cancellationError = () => Object.assign(new Error('Generation cancelled'), { name: 'AbortError' });

const stripTerminalCodes = value => value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/\r/g, '').trim();

const runCommand = (command, args, { timeout = 20_000, onOutput } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let output = '';
  const append = chunk => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
    onOutput?.(stripTerminalCodes(output));
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', reject);
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  child.on('close', code => {
    clearTimeout(timer);
    const cleanOutput = stripTerminalCodes(output);
    if (code === 0) resolve(cleanOutput);
    else reject(new Error(cleanOutput || `${command} exited with code ${code}`));
  });
});

const commandWorks = async (command, args, timeout = 10_000) => {
  try { await runCommand(command, args, { timeout }); return true; }
  catch { return false; }
};

const managedMarkerExists = async () => {
  try { await access(managedMarkerExecutable); return true; }
  catch { return false; }
};

const markerCommand = async () => await managedMarkerExists() ? managedMarkerExecutable : 'marker_single';

const hasSystemMarker = async () => {
  if (systemMarkerDetected === undefined) systemMarkerDetected = await commandWorks('marker_single', ['--help'], 15_000);
  return systemMarkerDetected;
};

const integrationStatus = async () => {
  const [codexInstalled, codexConnected, managedMarker, systemMarker] = await Promise.all([
    commandWorks('codex', ['--version']),
    commandWorks('codex', ['login', 'status']),
    managedMarkerExists(),
    hasSystemMarker(),
  ]);
  return {
    marker: { installed: managedMarker || systemMarker, managed: managedMarker, job: integrationJobs.marker },
    codex: { installed: codexInstalled, connected: codexConnected, job: integrationJobs.codex },
    gemini: { available: true },
  };
};

const installMarker = () => {
  if (integrationJobs.marker.state === 'working') return;
  integrationJobs.marker = { state: 'working', message: 'Creating Quizzer’s private Python environment…' };
  void (async () => {
    try {
      await runCommand('python3', ['-m', 'venv', managedMarkerDirectory], {
        timeout: 120_000,
        onOutput: output => { if (output) integrationJobs.marker.message = output; },
      });
      const pip = join(managedMarkerDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
      integrationJobs.marker.message = 'Downloading and installing Marker. This can take several minutes…';
      await runCommand(pip, ['install', '--upgrade', 'marker-pdf'], {
        timeout: 30 * 60_000,
        onOutput: output => { integrationJobs.marker.message = output || integrationJobs.marker.message; },
      });
      integrationJobs.marker = { state: 'complete', message: 'Marker is installed and ready.' };
    } catch (error) {
      integrationJobs.marker = { state: 'error', message: error instanceof Error ? error.message : 'Marker installation failed' };
    }
  })();
};

const connectCodex = () => {
  if (integrationJobs.codex.state === 'working') return;
  integrationJobs.codex = { state: 'working', message: 'Starting Codex device login…' };
  void runCommand('codex', ['login', '--device-auth'], {
    timeout: 15 * 60_000,
    onOutput: output => { integrationJobs.codex.message = output || integrationJobs.codex.message; },
  }).then(output => {
    integrationJobs.codex = { state: 'complete', message: output || 'Codex is connected.' };
  }).catch(error => {
    integrationJobs.codex = { state: 'error', message: error instanceof Error ? error.message : 'Codex login failed' };
  });
};

const runCodex = async ({ prompt, schema, model, images = [] }, signal) => {
  if (signal?.aborted) throw cancellationError();
  const work = await mkdtemp(join(tmpdir(), 'quizzer-codex-'));
  const schemaPath = join(work, 'schema.json');
  const outputPath = join(work, 'result.json');
  await writeFile(schemaPath, JSON.stringify(schema));
  const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
    '--output-schema', schemaPath, '--output-last-message', outputPath, '-'];
  if (model) args.splice(1, 0, '--model', model);
  for (const [index, image] of images.slice(0, 30).entries()) {
    const decoded = decodeImage(image, index);
    const imagePath = join(work, decoded.path);
    await writeFile(imagePath, decoded.data);
    args.splice(args.length - 1, 0, '--image', imagePath);
  }

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('codex', args, { stdio: ['pipe', 'ignore', 'pipe'], env: process.env });
      let errors = '';
      let failure;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        failure = cancellationError();
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => {
        failure = new Error('Codex timed out after 10 minutes');
        child.kill('SIGTERM');
      }, 600_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stderr.on('data', chunk => { errors += chunk.toString(); });
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup();
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error(errors.trim() || `Codex exited with code ${code}`));
      });
      child.stdin.end(prompt);
    });
    return await readFile(outputPath, 'utf8');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

const runGemini = async ({ prompt, schema, model, images = [], apiKey }, signal) => {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Enter a Gemini API key in Quizzer');
  const modelName = model || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, ...images.slice(0, 30).map(image => {
        const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(image);
        if (!match) throw new Error('Invalid image input');
        return { inlineData: { mimeType: match[1], data: match[2] } };
      })] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini failed (${response.status})`);
  const output = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  if (!output) throw new Error('Gemini returned an empty response');
  return output;
};

const walkFiles = async directory => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(path));
    else result.push(path);
  }
  return result;
};

const runMarker = async ({ name, data }) => {
  if (typeof data !== 'string' || !data) throw new Error('PDF data is required');
  const work = await mkdtemp(join(tmpdir(), 'quizzer-marker-'));
  const safeName = String(name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const input = join(work, safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`);
  const output = join(work, 'output');
  await writeFile(input, Buffer.from(data, 'base64'));
  try {
    const executable = await markerCommand();
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [input, '--output_dir', output, '--output_format', 'markdown'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk.toString(); });
      child.on('error', error => reject(error.code === 'ENOENT' ? new Error('Marker is not installed') : error));
      child.on('close', code => code === 0 ? resolve() : reject(new Error(errors.trim() || `Marker exited with code ${code}`)));
    });
    const files = await walkFiles(output);
    const markdownPath = files.find(path => path.endsWith('.md'));
    if (!markdownPath) throw new Error('Marker produced no Markdown output');
    const imagePaths = files.filter(path => /\.(png|jpe?g|webp)$/i.test(path));
    const images = await Promise.all(imagePaths.slice(0, 30).map(async path => ({
      name: path.split('/').pop(),
      mimeType: path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
      data: (await readFile(path)).toString('base64'),
    })));
    return { content: await readFile(markdownPath, 'utf8'), images };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': 'http://localhost:5173', 'Access-Control-Allow-Headers': 'Content-Type' });
    return response.end();
  }
  if (request.method === 'GET' && request.url === '/api/health') {
    return send(response, 200, { ok: true, providers: { codex: true, gemini: true } });
  }
  if (request.method === 'GET' && request.url === '/api/integrations') {
    return send(response, 200, await integrationStatus());
  }
  if (request.method === 'POST' && request.url === '/api/integrations/marker/install') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    installMarker();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/codex/connect') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    connectCodex();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/extract') {
    try { return send(response, 200, await runMarker(await readJson(request))); }
    catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'Extraction failed' }); }
  }
  if (request.method === 'POST' && request.url === '/api/embed') {
    try {
      const { texts } = await readJson(request);
      if (!Array.isArray(texts) || !texts.length || texts.length > 250 || texts.some(text => typeof text !== 'string')) {
        throw new Error('texts must be an array of 1-250 strings');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const embeddingResponse = await fetch(`${ollamaHost.replace(/\/$/, '')}/api/embed`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ model: process.env.QUIZZER_EMBEDDING_MODEL || 'all-minilm', input: texts }),
        });
        const payload = await embeddingResponse.json();
        if (!embeddingResponse.ok || !Array.isArray(payload.embeddings)) throw new Error('Local embedding model is unavailable');
        return send(response, 200, { embeddings: payload.embeddings });
      } finally { clearTimeout(timer); }
    } catch (error) {
      return send(response, 503, { error: error instanceof Error ? error.message : 'Embedding failed' });
    }
  }
  if (request.method !== 'POST' || request.url !== '/api/generate') return send(response, 404, { error: 'Not found' });

  const generationController = new AbortController();
  request.on('aborted', () => generationController.abort());
  response.on('close', () => {
    if (!response.writableEnded) generationController.abort();
  });
  try {
    const body = await readJson(request);
    if (!body || typeof body.prompt !== 'string' || !body.schema) throw new Error('prompt and schema are required');
    if (body.provider !== 'codex' && body.provider !== 'gemini') throw new Error('Unsupported provider');
    const output = body.provider === 'codex' ? await runCodex(body, generationController.signal) : await runGemini(body, generationController.signal);
    if (!response.destroyed) send(response, 200, { output });
  } catch (error) {
    if (!response.destroyed) send(response, error?.name === 'AbortError' ? 499 : 500, { error: error instanceof Error ? error.message : 'Generation failed' });
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Quizzer service listening on http://127.0.0.1:${port}\n`);
});
