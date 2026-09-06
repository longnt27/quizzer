import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectDirectory = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const waitFor = async (read, predicate, message) => {
  let lastValue;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const value = await read();
    lastValue = value;
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${message}\nLast value: ${JSON.stringify(lastValue)}`);
};

test('local service finishes a queued quiz without a renderer worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-generation-service-'));
  const executableDirectory = join(directory, 'bin');
  const fakeCodex = join(executableDirectory, 'codex');
  const token = 'generation-service-token-0123456789';
  let origin;
  let output = '';
  let errors = '';
  let service;
  try {
    await mkdir(executableDirectory, { recursive: true });
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const outputPath = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const number = Number(/Create exactly (\\d+)/.exec(prompt)?.[1] || 1);
  const questions = Array.from({ length: number }, (_, index) => ({
    type: 'multiple-choice',
    statement: 'Which lease behavior ' + (index + 1) + ' protects a shared state update?',
    answer: [
      { correct: true, content: 'Acquire exclusive ownership ' + (index + 1), explanation: 'Exclusive ownership serializes writers before shared changes.' },
      { correct: false, content: 'Delete the state ' + (index + 1), explanation: 'Deletion loses state and does not coordinate concurrent writers.' },
      { correct: false, content: 'Retry without a lock ' + (index + 1), explanation: 'An uncoordinated retry can reproduce the same write conflict.' }
    ]
  }));
  fs.writeFileSync(outputPath, JSON.stringify({ questions }));
});
`, { mode: 0o700 });
    await chmod(fakeCodex, 0o700);
    service = spawn(process.execPath, ['server.mjs'], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        PATH: `${executableDirectory}${delimiter}${process.env.PATH ?? ''}`,
        QUIZZER_APP_DATA_DIR: directory,
        QUIZZER_DATABASE_PATH: join(directory, 'quizzer.sqlite'),
        QUIZZER_API_TOKEN: token,
        QUIZZER_SERVICE_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout.on('data', chunk => {
      output += chunk.toString();
      origin ??= /Quizzer service listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    });
    service.stderr.on('data', chunk => { errors += chunk.toString(); });

    await waitFor(
      async () => origin,
      Boolean,
      `Generation service did not start:\n${output}\n${errors}`,
    );
    const request = (path, init = {}) => fetch(`${origin}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const content = '# Safe coordination\n\nA lease grants one writer exclusive ownership until the protected update is committed.';
    const synced = await request('/api/storage/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: [{
        collection: 'documents', id: 'service-document',
        data: { id: 'service-document', name: 'Lease guide.md', createdAt: 1, mimeType: 'text/markdown', size: content.length, tags: [], content },
      }] }),
    });
    assert.equal(synced.status, 200);
    const settings = await (await request('/api/v1/settings')).json();
    const options = {
      provider: 'codex', questionCount: 2,
      questionCounts: { multipleChoice: 2, fillBlank: 0, reasoning: 0, coding: 0 },
      multipleChoiceMode: 'single', coverageStrategy: 'balanced',
      customInstruction: 'Focus on safe writes.',
      promptProfileSnapshot: {
        id: 'service-test', version: 1, name: 'Service test',
        template: 'Create exactly {{count}} new, challenging {{questionType}} quiz-question candidates. {{typeInstructions}} {{multipleChoiceRule}} {{instruction}} Already accepted: {{acceptedQuestions}}',
      },
      ragProfile: { id: 'lite', retrieval: 'sparse', contextBudget: 4096, rerank: false },
      routeChain: [{ provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true }],
      resolvedSettings: settings.values,
    };
    const created = await request('/api/v1/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs: [{
        id: 'service-job', testId: 'service-test-result', name: 'Service-owned quiz',
        createdAt: 2, updatedAt: 2, status: 'queued', documentIds: ['service-document'],
        options, questions: [], rejected: 0, rounds: {},
      }] }),
    });
    assert.equal(created.status, 201);

    const completedJob = await waitFor(
      async () => (await (await request('/api/v1/jobs')).json()).jobs.find(job => job.id === 'service-job'),
      job => job?.status === 'completed',
      `Service-owned generation did not complete:\n${output}\n${errors}`,
    );
    assert.equal(completedJob.questions.length, 2);
    assert.equal(completedJob.workerId, undefined);
    assert.equal(completedJob.providerAttempts.at(-1).outcome, 'completed');
    assert.ok(completedJob.questions.every(question => question.provenance.sourceSpanIds[0].startsWith('service-document:')));

    const snapshot = await (await request('/api/storage/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: 0, changes: [] }),
    })).json();
    const generatedTest = snapshot.changes.find(change => change.collection === 'tests' && change.id === 'service-test-result');
    assert.equal(generatedTest.data.questions.length, 2);
    assert.equal(generatedTest.data.generationOptions.customInstruction, 'Focus on safe writes.');
  } finally {
    service?.kill('SIGTERM');
    if (service && service.exitCode === null) await new Promise(resolve => service.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
