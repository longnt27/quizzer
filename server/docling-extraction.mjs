import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { terminateChild } from './process-control.mjs';

export const DOCLING_VERSION = '2.126.0';
export const DOCLING_PACKAGE_SPEC = `docling==${DOCLING_VERSION}`;
export const DOCLING_BRIDGE_SENTINEL = '__QUIZZER_DOCLING__';
const MAX_DOCUMENT_BYTES = 250 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 12 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 8 * 1024 * 1024;
const MAX_PAGE_CHARACTERS = 2 * 1024 * 1024;
const MAX_PAGES = 1_000_000;

const abortError = signal => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Docling extraction was cancelled'), { name: 'AbortError' });
const unavailable = message => Object.assign(new Error(message), { code: 'provider_unavailable' });

const runBoundedCommand = (command, args, { signal, timeout = 10 * 60_000 } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError(signal));
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer;
  const finish = callback => value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    callback(value);
  };
  const fail = finish(reject);
  const succeed = finish(resolve);
  const append = (current, chunk) => {
    const next = current + chunk.toString('utf8');
    if (next.length > MAX_COMMAND_OUTPUT) {
      terminateChild(child, 'SIGKILL');
      fail(unavailable('Docling produced an oversized response.'));
    }
    return next;
  };
  child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
  child.once('error', error => fail(error));
  child.once('close', code => {
    if (settled) return;
    if (code === 0) succeed(stdout);
    else fail(unavailable(`Docling exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ''}`));
  });
  const onAbort = () => {
    terminateChild(child, 'SIGTERM');
    fail(abortError(signal));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => {
    terminateChild(child, 'SIGKILL');
    fail(unavailable('Docling extraction timed out.'));
  }, timeout);
  timer.unref?.();
});

const validatePages = payload => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.pages) || !payload.pages.length) {
    throw unavailable('Docling returned no readable pages.');
  }
  if (payload.pages.length > MAX_PAGES) throw unavailable('Docling returned too many pages.');
  const seen = new Set();
  let total = 0;
  const pages = payload.pages.map((page, index) => {
    if (!page || typeof page !== 'object' || !Number.isSafeInteger(page.page) || page.page < 1 || seen.has(page.page)) {
      throw unavailable(`Docling returned invalid page metadata at item ${index + 1}.`);
    }
    if (typeof page.markdown !== 'string' || !page.markdown.trim() || page.markdown.length > MAX_PAGE_CHARACTERS) {
      throw unavailable(`Docling returned invalid content for page ${page.page}.`);
    }
    seen.add(page.page);
    const markdown = page.markdown.trim();
    total += markdown.length;
    if (total > MAX_EXTRACTED_CHARACTERS) throw unavailable('Docling returned too much extracted text.');
    return { page: page.page, markdown };
  });
  return pages;
};

const parseBridgeOutput = output => {
  if (typeof output !== 'string' || output.length > MAX_COMMAND_OUTPUT) throw unavailable('Docling returned invalid bridge output.');
  const marker = output.lastIndexOf(DOCLING_BRIDGE_SENTINEL);
  if (marker < 0) throw unavailable('Docling returned invalid bridge output.');
  const serialized = output.slice(marker + DOCLING_BRIDGE_SENTINEL.length).trim();
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw unavailable('Docling returned invalid bridge output.'); }
  return validatePages(payload);
};

export const runDoclingExtraction = async (data, {
  python,
  scriptPath,
  name = 'document.pdf',
  mimeType = 'application/pdf',
  signal,
  tempRoot = tmpdir(),
  runCommand = runBoundedCommand,
} = {}) => {
  if (signal?.aborted) throw abortError(signal);
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('Docling document must be binary');
  const source = Buffer.from(data);
  if (!source.length || source.length > MAX_DOCUMENT_BYTES) throw new Error('Docling document exceeds the 250 MB limit');
  if (typeof python !== 'string' || !python.trim()) throw unavailable('Docling is not installed. Install it from Document settings first.');
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) throw unavailable('Docling bridge is unavailable.');
  if (typeof name !== 'string' || !name.trim() || name.length > 1024) throw new Error('Docling document name is invalid');
  if (typeof mimeType !== 'string' || !mimeType.trim() || mimeType.length > 255) throw new Error('Docling document MIME type is invalid');
  if (typeof runCommand !== 'function') throw new Error('Docling command runner is invalid');

  const extension = /^\.[A-Za-z0-9]{1,12}$/.test(extname(name)) ? extname(name).toLowerCase() : '.bin';
  const directory = await mkdtemp(join(tempRoot, 'quizzer-docling-'));
  const sourcePath = join(directory, `document${extension}`);
  try {
    await writeFile(sourcePath, source, { mode: 0o600 });
    let output;
    try {
      output = await runCommand(python, [scriptPath, sourcePath], { signal, timeout: 10 * 60_000 });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (error?.code === 'provider_unavailable') throw error;
      throw unavailable(`Docling extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pages = parseBridgeOutput(output);
    return {
      content: pages.map(page => `--- Page ${page.page} ---\n${page.markdown}`).join('\n\n'),
      pageCount: pages.length,
      parserVersion: `docling-${DOCLING_VERSION}`,
      extractor: 'docling',
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
