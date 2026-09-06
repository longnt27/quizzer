import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-index-restart-'));
const token = 'quizzer-restart-token-0123456789';

const startService = async () => {
  let stdout = '';
  let stderr = '';
  let origin;
  let exited;
  const processHandle = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      QUIZZER_APP_DATA_DIR: directory,
      QUIZZER_DATABASE_PATH: join(directory, 'quizzer.sqlite'),
      QUIZZER_API_TOKEN: token,
      QUIZZER_SERVICE_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processHandle.stdout.on('data', chunk => {
    stdout += chunk;
    origin ??= /Quizzer service listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
  });
  processHandle.stderr.on('data', chunk => { stderr += chunk; });
  processHandle.once('exit', (code, signal) => { exited = { code, signal }; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (exited) throw new Error(`Service exited during restart test (${JSON.stringify(exited)}): ${stdout}${stderr}`);
    try {
      if (origin && (await fetch(`${origin}/api/health`)).ok) {
        return {
          authorized: (path, init = {}) => fetch(`${origin}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
          }),
          stop: async () => {
            processHandle.kill('SIGTERM');
            if (!exited) await new Promise(resolve => processHandle.once('exit', resolve));
          },
          stderr: () => stderr,
        };
      }
    } catch { /* Service is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  processHandle.kill('SIGTERM');
  throw new Error(`Service did not start during restart test: ${stdout}${stderr}`);
};

test.after(async () => rm(directory, { recursive: true, force: true }));

test('recovers and finishes an interrupted indexing job after service restart', async () => {
  const first = await startService();
  const seeded = await first.authorized('/api/storage/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [
      {
        collection: 'documents', id: 'restart-doc',
        data: {
          id: 'restart-doc', name: 'Restart.md', createdAt: 1, mimeType: 'text/markdown', size: 40, tags: [],
          content: '# Recovery\n\nOnly uncommitted documents should run after restart.',
        },
      },
      {
        collection: 'indexJobs', id: 'restart-index-job',
        data: {
          id: 'restart-index-job', kind: 'index', status: 'running', documentIds: ['restart-doc'],
          remainingDocumentIds: ['restart-doc'], completedDocumentIds: [], results: [], force: false,
          createdAt: 1, updatedAt: 2, startedAt: 2,
        },
      },
    ] }),
  });
  assert.equal(seeded.status, 200);
  await first.stop();

  const second = await startService();
  try {
    let completed;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await second.authorized('/api/v1/index/jobs/restart-index-job');
      const payload = await response.json();
      if (payload.job?.status === 'completed') {
        completed = payload.job;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(completed?.status, 'completed');
    assert.equal(completed.recoveredAt >= completed.startedAt, true);
    assert.deepEqual(completed.completedDocumentIds, ['restart-doc']);
    assert.deepEqual(completed.remainingDocumentIds, []);
    assert.equal(second.stderr(), '');
  } finally {
    await second.stop();
  }
});
