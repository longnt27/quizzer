import { createHash } from 'node:crypto';
import { ensure } from './dataset.mjs';

export async function downloadSource(source, { fetcher = fetch, maxBytes = 50 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  const url = new URL(source.url);
  ensure(url.protocol === 'https:' && url.hostname === 'users.soict.hust.edu.vn'
    && !url.username && !url.password && !url.port, 'Automatic download host is not allowlisted');
  ensure(/^[a-z0-9-]+$/.test(source.id), 'Invalid source id');
  ensure(Number.isInteger(maxBytes) && maxBytes > 0, 'Invalid download size bound');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  ensure(response.ok, `Source ${source.id}: HTTP ${response.status}`);
  ensure(response.body, 'PDF response has no body');
  const declared = response.headers.get('content-length');
  ensure(!declared || Number(declared) <= maxBytes, 'PDF exceeds download size bound');
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      ensure(size <= maxBytes, 'PDF exceeds download size bound'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  ensure(bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'Source response is not a PDF');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  ensure(!source.sha256 || sha256 === source.sha256, `Source ${source.id}: fingerprint mismatch`);
  return { bytes, sha256 };
}

export function verifySourceLock(sources, lock) {
  ensure(lock?.version === 1 && Array.isArray(lock.sources) && lock.sources.length === sources.length, 'Source lock must cover the complete source set');
  const entries = new Map(lock.sources.map(entry => [entry.id, entry]));
  ensure(entries.size === sources.length, 'Source lock contains duplicate ids');
  for (const source of sources) {
    const entry = entries.get(source.id);
    ensure(entry && entry.url === source.url && /^[a-f0-9]{64}$/.test(entry.sha256)
      && Number.isInteger(entry.bytes) && entry.bytes > 5, `Source lock is invalid for ${source.id}`);
    ensure(!source.sha256 || source.sha256 === entry.sha256, `Source lock fingerprint mismatch for ${source.id}`);
  }
  return lock;
}
