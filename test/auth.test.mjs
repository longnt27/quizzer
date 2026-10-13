import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureServiceToken, isAuthorizedRequest, isTrustedServiceHost, serviceSessionCookie } from '../server/auth.mjs';

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

test('accepts the HttpOnly same-site browser session cookie', async () => {
  const token = await ensureServiceToken(directory, {});
  const cookie = serviceSessionCookie(token);
  assert.match(cookie, /^quizzer_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(isAuthorizedRequest({ headers: { host: '127.0.0.1:8787', cookie } }, token), true);
  assert.equal(isAuthorizedRequest({ headers: { host: 'localhost:8787', cookie: 'quizzer_session=incorrect' } }, token), false);
  assert.match(serviceSessionCookie(token, { secure: true }), /; Secure$/);
});

test('rejects rebound, malformed, and missing Host headers', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:8787', 'localhost:8787', 'LOCALHOST']) {
    assert.equal(isTrustedServiceHost({ headers: { host } }), true, host);
  }
  for (const host of [undefined, 'untrusted.example:8787', 'localhost.evil', 'localhost@evil', '127.1',
    'localhost/path', 'localhost:0', 'localhost:65536', 'localhost:abc', ['localhost'], 'localhost\n']) {
    assert.equal(isTrustedServiceHost({ headers: { host } }), false, String(host));
  }
});

test('browser cookies cannot authorize other origins or loopback ports', async () => {
  const token = await ensureServiceToken(directory, {});
  const headers = { host: '127.0.0.1:8787', cookie: serviceSessionCookie(token) };
  assert.equal(isAuthorizedRequest({ headers: { ...headers, origin: 'http://127.0.0.1:8787' } }, token), true);
  for (const origin of ['http://untrusted.example', 'http://127.0.0.1:1234', 'http://localhost:8787', 'null', ['http://127.0.0.1:8787']]) {
    assert.equal(isAuthorizedRequest({ headers: { ...headers, origin } }, token), false);
  }
  for (const site of ['same-site', 'cross-site']) {
    assert.equal(isAuthorizedRequest({ headers: { ...headers, 'sec-fetch-site': site } }, token), false);
  }
  assert.equal(isAuthorizedRequest({ headers: { ...headers, 'sec-fetch-site': 'same-origin' } }, token), true);
  assert.equal(isAuthorizedRequest({ headers: { cookie: headers.cookie, host: 'untrusted.example' } }, token), false);
  // Explicit service credentials still work through the development proxy.
  assert.equal(isAuthorizedRequest({ headers: { ...headers, origin: 'http://localhost:5173', authorization: `Bearer ${token}` } }, token), true);
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
