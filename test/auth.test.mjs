import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
});
