import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isAllowedExternalUrl, isTrustedRendererUrl } from '../desktop/security.mjs';

test('opens only credential-free HTTPS links outside Quizzer', () => {
  assert.equal(isAllowedExternalUrl('https://docs.example.com/guide?q=1'), true);
  assert.equal(isAllowedExternalUrl('http://docs.example.com'), false);
  assert.equal(isAllowedExternalUrl('https://user:secret@docs.example.com'), false);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('not a url'), false);
});

test('trusts only the packaged application origin or the exact development origin', () => {
  assert.equal(isTrustedRendererUrl('quizzer://app/'), true);
  assert.equal(isTrustedRendererUrl('quizzer://app/documents/one'), true);
  assert.equal(isTrustedRendererUrl('quizzer://other/'), false);
  assert.equal(isTrustedRendererUrl('https://app/'), false);
  assert.equal(isTrustedRendererUrl('quizzer://user@app/'), false);

  const developmentUrl = 'http://127.0.0.1:5173/';
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/settings', developmentUrl), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/', developmentUrl), false);
  assert.equal(isTrustedRendererUrl('https://127.0.0.1:5173/', developmentUrl), false);
  assert.equal(isTrustedRendererUrl('not a url', developmentUrl), false);
});

test('ships a renderer CSP without remote scripts, broad sockets, forms, or framing', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const policy = /Content-Security-Policy" content="([^"]+)/.exec(html)?.[1];
  assert.ok(policy);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self';/);
  assert.doesNotMatch(policy, /https?:\/\//);
  assert.doesNotMatch(policy, /\bws:/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /form-action 'none'/);
});
