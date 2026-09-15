import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DOCLING_PACKAGE_SPEC, DOCLING_VERSION, runDoclingExtraction,
} from '../server/docling-extraction.mjs';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'quizzer-docling-test-'));
test.after(async () => rm(temporaryRoot, { recursive: true, force: true }));

test('runs the managed local bridge and normalizes page-marked Markdown', async () => {
  const controller = new AbortController();
  let sourcePath;
  const result = await runDoclingExtraction(Buffer.from('%PDF-test'), {
    python: '/managed/docling/python',
    scriptPath: '/app/scripts/docling_extract.py',
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    signal: controller.signal,
    tempRoot: temporaryRoot,
    runCommand: async (command, args, options) => {
      assert.equal(command, '/managed/docling/python');
      assert.equal(args[0], '/app/scripts/docling_extract.py');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.timeout, 10 * 60_000);
      sourcePath = args[1];
      assert.equal(await readFile(sourcePath, 'utf8'), '%PDF-test');
      return `docling log line\n__QUIZZER_DOCLING__${JSON.stringify({
        pages: [
          { page: 1, markdown: '# Title' },
          { page: 2, markdown: 'Second page' },
        ],
      })}`;
    },
  });

  assert.equal(DOCLING_VERSION, '2.126.0');
  assert.equal(DOCLING_PACKAGE_SPEC, 'docling==2.126.0');
  assert.equal(result.extractor, 'docling');
  assert.equal(result.parserVersion, 'docling-2.126.0');
  assert.equal(result.pageCount, 2);
  assert.equal(result.content, '--- Page 1 ---\n# Title\n\n--- Page 2 ---\nSecond page');
  await assert.rejects(access(sourcePath), error => error?.code === 'ENOENT');
});

test('rejects unsafe or empty Docling bridge output', async () => {
  const base = {
    python: '/managed/docling/python',
    scriptPath: '/app/scripts/docling_extract.py',
    tempRoot: temporaryRoot,
  };
  await assert.rejects(runDoclingExtraction(Buffer.from('pdf'), {
    ...base,
    runCommand: async () => 'ordinary stdout without sentinel',
  }), /invalid bridge output/i);
  await assert.rejects(runDoclingExtraction(Buffer.from('pdf'), {
    ...base,
    runCommand: async () => '__QUIZZER_DOCLING__{"pages":[]}',
  }), /no readable pages/i);
});

test('propagates cancellation without turning it into provider failure', async () => {
  const controller = new AbortController();
  const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  await assert.rejects(runDoclingExtraction(Buffer.from('pdf'), {
    python: '/managed/docling/python',
    scriptPath: '/app/scripts/docling_extract.py',
    tempRoot: temporaryRoot,
    signal: controller.signal,
    runCommand: async () => { throw abort; },
  }), error => error?.name === 'AbortError');
});
