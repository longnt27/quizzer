import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureServiceToken, isAuthorizedRequest } from '../server/auth.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quizzer-auth-test-'));
test.after(async () => rm(directory, { recursive: true, force: true }));

test('creates and reuses a private service token', async () => {
  const first = await ensureServiceToken(directory, {});
  const second = await ensureServiceToken(directory, {});
  assert.equal(first, second);
  assert.ok(first.length >= 32);
  assert.equal((await stat(join(directory, 'service-token'))).mode & 0o777, 0o600);
});

test('accepts bearer and explicit token headers without exposing the token', async () => {
  const token = await ensureServiceToken(directory, {});
  assert.equal(isAuthorizedRequest({ headers: { authorization: `Bearer ${token}` } }, token), true);
  assert.equal(isAuthorizedRequest({ headers: { 'x-quizzer-token': token } }, token), true);
  assert.equal(isAuthorizedRequest({ headers: { authorization: 'Bearer incorrect' } }, token), false);
  assert.equal(isAuthorizedRequest({ headers: {} }, token), false);
  assert.equal(isAuthorizedRequest({ headers: { authorization: 'Basic credentials', 'x-quizzer-token': 42 } }, token), false);
});

test('prefers an explicit environment token and rejects corrupt stored credentials', async () => {
  const environmentToken = 'environment-token-that-is-long-enough';
  const environmentDirectory = join(directory, 'environment');
  assert.equal(await ensureServiceToken(environmentDirectory, { QUIZZER_API_TOKEN: `  ${environmentToken}  ` }), environmentToken);
  await assert.rejects(stat(environmentDirectory), /ENOENT/);

  const corruptedDirectory = join(directory, 'corrupted');
  await mkdir(corruptedDirectory);
  await writeFile(join(corruptedDirectory, 'service-token'), 'too-short\n');
  await assert.rejects(ensureServiceToken(corruptedDirectory, {}), /service token is invalid/);
});
