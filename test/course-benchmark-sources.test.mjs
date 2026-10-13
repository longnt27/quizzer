import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadSource, verifySourceLock } from '../eval/course-benchmark/sources.mjs';
import { createHash } from 'node:crypto';
const bytes = Buffer.from('%PDF-1.7\nexample-test-bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const source = { id: 's1', url: 'https://users.soict.hust.edu.vn/test.pdf', sha256: null };
const response = () => new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
test('downloader hashes actual bytes, never URL strings', async () => {
  const result = await downloadSource(source, { fetcher: async () => response() });
  assert.equal(result.sha256, sha256); assert.equal(result.bytes.length, bytes.length);
});
test('HTML/login pages and non-200 responses cannot become PDFs', async () => {
  await assert.rejects(downloadSource(source, { fetcher: async () => new Response('<html>login</html>') }), /PDF/);
  await assert.rejects(downloadSource(source, { fetcher: async () => new Response('unavailable', { status: 503 }) }), /HTTP/);
});
test('known source hash mismatch fails rather than silently replacing the source', async () => {
  await assert.rejects(downloadSource({ ...source, sha256: 'a'.repeat(64) }, { fetcher: async () => response() }), /fingerprint/);
});
test('only the reviewed instructor host is eligible for automatic downloads', async () => {
  await assert.rejects(downloadSource({ ...source, url: 'https://other.example/a.pdf' }), /host/);
});
test('response size is capped even without a Content-Length header', async () => {
  await assert.rejects(downloadSource(source, { maxBytes: 5, fetcher: async () => response() }), /size/);
});
test('source lock requires the exact complete set and matching URLs/pins', () => {
  const entry = { id: source.id, url: source.url, sha256, bytes: bytes.length };
  assert.doesNotThrow(() => verifySourceLock([source], { version: 1, sources: [entry] }));
  for (const entries of [[], [entry, entry], [{ ...entry, url: 'https://other.example/a.pdf' }], [{ ...entry, sha256: null }]]) {
    assert.throws(() => verifySourceLock([source], { version: 1, sources: entries }), /lock/);
  }
});
