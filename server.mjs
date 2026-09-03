import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageInfo, syncStorage } from './server/storage.mjs';

const port = Number(process.env.QUIZZER_SERVICE_PORT || 8787);
const maxBodyBytes = 25 * 1024 * 1024;
const maxStorageBodyBytes = 250 * 1024 * 1024;
const managedMarkerDirectory = join(process.cwd(), '.quizzer-tools', 'marker');
const managedMarkerExecutable = join(managedMarkerDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'marker_single.exe' : 'marker_single');
const integrationJobs = {
  marker: { state: 'idle', message: '' },
  codex: { state: 'idle', message: '' },
  'claude-agent': { state: 'idle', message: '' },
  'antigravity-agent': { state: 'idle', message: '' },
  embeddings: { state: 'idle', message: '' },
};
let systemMarkerDetected;

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:5173' });
  response.end(JSON.stringify(body));
};

const readJson = (request, limit = maxBodyBytes) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let failed = false;
  request.on('data', chunk => {
    if (failed) return;
    size += chunk.length;
    if (size > limit) {
      failed = true;
      reject(new Error('Request is too large'));
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (failed) return;
    try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
    catch { reject(new Error('Invalid JSON request')); }
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
  const [codexInstalled, codexConnected, claudeInstalled, claudeConnected, antigravityInstalled, ollamaInstalled, ollamaModels, managedMarker, systemMarker] = await Promise.all([
    commandWorks('codex', ['--version']),
    commandWorks('codex', ['login', 'status']),
    commandWorks('claude', ['--version']),
    commandWorks('claude', ['auth', 'status']),
    commandWorks('agy', ['--version']),
    commandWorks('ollama', ['--version']),
    runCommand('ollama', ['list'], { timeout: 8_000 }).catch(() => ''),
    managedMarkerExists(),
    hasSystemMarker(),
  ]);
  return {
    marker: { installed: managedMarker || systemMarker, managed: managedMarker, job: integrationJobs.marker },
    codex: { installed: codexInstalled, connected: codexConnected, job: integrationJobs.codex },
    'claude-agent': { installed: claudeInstalled, connected: claudeConnected, job: integrationJobs['claude-agent'] },
    'antigravity-agent': {
      installed: antigravityInstalled,
      connected: integrationJobs['antigravity-agent'].state === 'complete',
      job: integrationJobs['antigravity-agent'],
    },
    gemini: { available: true },
    anthropic: { available: true },
    openai: { available: true },
    openrouter: { available: true },
    deepseek: { available: true },
    embeddings: {
      installed: /(?:^|\s)all-minilm(?::\S+)?(?:\s|$)/mi.test(ollamaModels),
      runtimeInstalled: ollamaInstalled,
      job: integrationJobs.embeddings,
    },
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

const connectAgent = (provider, command, args, startingMessage) => {
  if (integrationJobs[provider].state === 'working') return;
  integrationJobs[provider] = { state: 'working', message: startingMessage };
  void runCommand(command, args, {
    timeout: 15 * 60_000,
    onOutput: output => { integrationJobs[provider].message = output || integrationJobs[provider].message; },
  }).then(output => {
    integrationJobs[provider] = { state: 'complete', message: output || `${provider} is connected.` };
  }).catch(error => {
    integrationJobs[provider] = { state: 'error', message: error instanceof Error ? error.message : `${provider} login failed` };
  });
};

const connectClaude = () => connectAgent('claude-agent', 'claude', ['auth', 'login'], 'Starting Claude sign-in…');
const connectAntigravity = () => connectAgent(
  'antigravity-agent', 'agy', ['-p', '/model', '--output-format', 'json'], 'Starting Antigravity sign-in…',
);

const downloadAndRunScript = async (url, args, onOutput) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Installer download failed (${response.status})`);
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-installer-'));
  const path = join(directory, 'install.sh');
  try {
    await writeFile(path, await response.text(), { mode: 0o700 });
    return await runCommand('bash', [path, ...args], { timeout: 15 * 60_000, onOutput });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const installAgent = (provider, url) => {
  if (integrationJobs[provider].state === 'working') return;
  integrationJobs[provider] = { state: 'working', message: `Downloading the official ${provider === 'claude-agent' ? 'Claude' : 'Antigravity'} installer…` };
  void downloadAndRunScript(url, [], output => { integrationJobs[provider].message = output || integrationJobs[provider].message; })
    .then(output => { integrationJobs[provider] = { state: 'complete', message: output || 'Agent installed. Connect your account next.' }; })
    .catch(error => { integrationJobs[provider] = { state: 'error', message: error instanceof Error ? error.message : 'Agent installation failed' }; });
};

const installEmbeddings = () => {
  if (integrationJobs.embeddings.state === 'working') return;
  integrationJobs.embeddings = { state: 'working', message: 'Preparing the local embedding runtime…' };
  void (async () => {
    const update = output => { integrationJobs.embeddings.message = output || integrationJobs.embeddings.message; };
    if (!await commandWorks('ollama', ['--version'])) {
      if (process.platform === 'darwin') await runCommand('brew', ['install', 'ollama'], { timeout: 15 * 60_000, onOutput: update });
      else if (process.platform === 'linux') await downloadAndRunScript('https://ollama.com/install.sh', [], update);
      else throw new Error('Install Ollama from ollama.com, then retry this button.');
    }
    if (!await commandWorks('ollama', ['list'], 5_000)) {
      const executable = process.platform === 'darwin' ? '/opt/homebrew/bin/ollama' : 'ollama';
      const server = spawn(executable, ['serve'], { detached: true, stdio: 'ignore', env: process.env });
      server.unref();
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    integrationJobs.embeddings.message = 'Downloading all-minilm…';
    await runCommand('ollama', ['pull', 'all-minilm'], { timeout: 30 * 60_000, onOutput: update });
    integrationJobs.embeddings = { state: 'complete', message: 'all-minilm is installed and semantic duplicate filtering is ready.' };
  })().catch(error => {
    integrationJobs.embeddings = { state: 'error', message: error instanceof Error ? error.message : 'Embedding installation failed' };
  });
};

const runCapturedCommand = (command, args, prompt, signal, timeout = 600_000) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(cancellationError());
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stdout = '';
  let stderr = '';
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
    failure = new Error(`${command} timed out after ${Math.round(timeout / 60_000)} minutes`);
    child.kill('SIGTERM');
  }, timeout);
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', error => { cleanup(); reject(error); });
  child.on('close', code => {
    cleanup();
    if (failure) reject(failure);
    else if (code === 0) resolve(stdout.trim());
    else reject(new Error(stripTerminalCodes(stderr || stdout) || `${command} exited with code ${code}`));
  });
  child.stdin.end(prompt);
});

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

const runClaudeAgent = async ({ prompt, schema, model }, signal) => {
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--permission-mode', 'plan', '--max-turns', '1', '--no-session-persistence'];
  if (model) args.push('--model', model);
  const output = await runCapturedCommand('claude', args, prompt, signal);
  const envelope = JSON.parse(output);
  const structured = envelope.structured_output ?? envelope.result;
  if (!structured) throw new Error(envelope.error || 'Claude Agent returned no structured output');
  return typeof structured === 'string' ? structured : JSON.stringify(structured);
};

const runAntigravityAgent = async ({ prompt, schema, model }, signal) => {
  const args = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--sandbox', '--print-timeout', '10m'];
  if (model) args.push('--model', model);
  const output = await runCapturedCommand('agy', args, '', signal);
  const envelope = JSON.parse(output);
  if (envelope.status !== 'SUCCESS') throw new Error(envelope.error || 'Antigravity Agent failed');
  const structured = envelope.structured_output ?? envelope.response;
  if (!structured) throw new Error('Antigravity Agent returned no structured output');
  return typeof structured === 'string' ? structured : JSON.stringify(structured);
};

const runGemini = async ({ prompt, schema, model, images = [], apiKey }, signal) => {
  requireApiKey(apiKey, 'Gemini');
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
  const payload = await parseApiResponse(response, 'Gemini');
  const output = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  if (!output) throw new Error('Gemini returned an empty response');
  return output;
};

class ProviderError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const providerErrorCode = status => status === 401 || status === 403
  ? 'provider_auth'
  : status === 402 || status === 429
    ? 'provider_limit'
    : status >= 500
      ? 'provider_unavailable'
      : 'provider_error';

const normalizeProviderError = error => {
  if (error instanceof ProviderError || error?.name === 'AbortError') return error;
  const message = error instanceof Error ? error.message : 'Generation failed';
  if (/usage limit|rate limit|quota|too many requests|insufficient (?:balance|credits)|credit balance|capacity/i.test(message)) {
    return new ProviderError(message, 429, 'provider_limit');
  }
  if (/not logged in|unauthorized|authentication|api key|sign[ -]?in|login required/i.test(message)) {
    return new ProviderError(message, 401, 'provider_auth');
  }
  return error;
};

const requireApiKey = (apiKey, label) => {
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ProviderError(`Enter ${article} ${label} API key in Quizzer`, 401, 'provider_auth');
};

const parseApiResponse = async (response, provider) => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `${provider} failed (${response.status})`;
    throw new ProviderError(message, response.status, providerErrorCode(response.status));
  }
  return payload;
};

const imageContent = images => images.slice(0, 30).map(image => ({ type: 'image_url', image_url: { url: image } }));

const runOpenAICompatible = async ({ prompt, schema, model, images = [], apiKey }, signal, config) => {
  requireApiKey(apiKey, config.label);
  const content = config.supportsImages && images.length
    ? [{ type: 'text', text: prompt }, ...imageContent(images)]
    : `${prompt}\n\nReturn JSON matching this schema exactly:\n${JSON.stringify(schema)}`;
  const response = await fetch(config.endpoint, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || config.defaultModel,
      messages: [{ role: 'user', content }],
      response_format: config.jsonSchema
        ? { type: 'json_schema', json_schema: { name: 'quiz_questions', strict: true, schema } }
        : { type: 'json_object' },
      ...(config.providerRouting ? { provider: { require_parameters: true } } : {}),
    }),
  });
  const payload = await parseApiResponse(response, config.label);
  const output = payload.choices?.[0]?.message?.content;
  if (!output) throw new Error(`${config.label} returned an empty response`);
  return output;
};

const runOpenAI = async ({ prompt, schema, model, images = [], apiKey }, signal) => {
  requireApiKey(apiKey, 'OpenAI');
  const content = [{ type: 'input_text', text: prompt }, ...images.slice(0, 30).map(image => ({ type: 'input_image', image_url: image }))];
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-5-mini',
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'quiz_questions', strict: true, schema } },
    }),
  });
  const payload = await parseApiResponse(response, 'OpenAI');
  const output = payload.output?.flatMap(item => item.content ?? []).find(item => item.type === 'output_text')?.text;
  if (!output) throw new Error('OpenAI returned an empty response');
  return output;
};

const runAnthropic = async ({ prompt, schema, model, images = [], apiKey }, signal) => {
  requireApiKey(apiKey, 'Anthropic');
  const content = [
    { type: 'text', text: prompt },
    ...images.slice(0, 30).map(image => {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(image);
      if (!match) throw new Error('Invalid image input');
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    }),
  ];
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-5-20250929', max_tokens: 8192,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema } },
    }),
  });
  const payload = await parseApiResponse(response, 'Anthropic');
  const output = payload.content?.find(block => block.type === 'text')?.text;
  if (!output) throw new Error('Anthropic returned an empty response');
  return output;
};

const providerRunners = {
  codex: runCodex,
  'claude-agent': runClaudeAgent,
  'antigravity-agent': runAntigravityAgent,
  gemini: runGemini,
  anthropic: runAnthropic,
  openai: runOpenAI,
  openrouter: (body, signal) => runOpenAICompatible(body, signal, {
    label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', defaultModel: 'openai/gpt-4o-mini', jsonSchema: true, supportsImages: true, providerRouting: true,
  }),
  deepseek: (body, signal) => runOpenAICompatible(body, signal, {
    label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', defaultModel: 'deepseek-chat', jsonSchema: false, supportsImages: false,
  }),
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
    return send(response, 200, { ok: true, storage: storageInfo(), providers: Object.fromEntries(Object.keys(providerRunners).map(provider => [provider, true])) });
  }
  if (request.method === 'POST' && request.url === '/api/storage/sync') {
    try { return send(response, 200, syncStorage(await readJson(request, maxStorageBodyBytes))); }
    catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : 'Storage sync failed' }); }
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
  if (request.method === 'POST' && request.url === '/api/integrations/claude-agent/connect') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    connectClaude();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/antigravity-agent/connect') {
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON request required' });
    connectAntigravity();
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/claude-agent/install') {
    installAgent('claude-agent', 'https://claude.ai/install.sh');
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/antigravity-agent/install') {
    installAgent('antigravity-agent', 'https://antigravity.google/cli/install.sh');
    return send(response, 202, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/api/integrations/embeddings/install') {
    installEmbeddings();
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
    const runner = providerRunners[body.provider];
    if (!runner) throw new Error('Unsupported provider');
    const output = await runner(body, generationController.signal);
    if (!response.destroyed) send(response, 200, { output });
  } catch (error) {
    const normalized = normalizeProviderError(error);
    if (!response.destroyed) send(response, normalized?.name === 'AbortError' ? 499 : normalized?.status || 500, {
      error: normalized instanceof Error ? normalized.message : 'Generation failed',
      code: normalized?.code,
    });
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Quizzer service listening on http://127.0.0.1:${port}\n`);
});
