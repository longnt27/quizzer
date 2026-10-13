import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDataset, ensure } from '../eval/course-benchmark/dataset.mjs';
import { downloadSource, verifySourceLock } from '../eval/course-benchmark/sources.mjs';

try {
  const [cache, output, consent, expectedPath] = process.argv.slice(2);
  ensure(cache && output && consent === '--acknowledge-source-terms',
    'Usage: node scripts/benchmark-sources.mjs CACHE_DIR OUTPUT_LOCK.json --acknowledge-source-terms [EXPECTED_LOCK.json]');
  const data = await loadDataset();
  const expected = expectedPath ? verifySourceLock(data.sources, JSON.parse(await readFile(expectedPath, 'utf8'))) : null;
  await mkdir(cache, { recursive: true });
  const entries = [];
  for (const source of data.sources) {
    const pin = expected?.sources.find(row => row.id === source.id)?.sha256 ?? source.sha256;
    const { bytes, sha256 } = await downloadSource({ ...source, sha256: pin });
    const destination = join(cache, `${source.id}.pdf`);
    try { await writeFile(destination, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      ensure((await readFile(destination)).equals(bytes), `Refusing to overwrite a different cached source: ${source.id}`);
    }
    entries.push({ id: source.id, url: source.url, sha256, bytes: bytes.length });
    console.error(`Verified ${source.id}: ${sha256}`);
  }
  const lock = verifySourceLock(data.sources, { version: 1, acquiredAt: new Date().toISOString(), sources: entries });
  await writeFile(output, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
  console.log(`Wrote complete source lock for ${entries.length} PDFs. This verifies bytes, not annotation correctness.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
