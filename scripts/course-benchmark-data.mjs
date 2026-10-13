import { writeFile } from 'node:fs/promises';
import { loadDataset, projectInput, fingerprint, ensure } from '../eval/course-benchmark/dataset.mjs';

try {
  const [command = 'validate', track, split, destination] = process.argv.slice(2);
  const data = await loadDataset();
  if (command === 'validate') {
    ensure(!track, 'Usage: node scripts/course-benchmark-data.mjs validate');
    console.log(JSON.stringify({ version: data.version, status: data.status, fingerprint: fingerprint(data),
      sources: data.sources.length, pages: data.sources.reduce((n, s) => n + s.pages, 0),
      retrieval: data.retrieval.length, generation: data.generation.length,
      reviewed: [...data.retrieval, ...data.generation].filter(r => r.review.status === 'reviewed').length }, null, 2));
  } else if (command === 'export') {
    ensure(['retrieval', 'generation'].includes(track) && ['dev', 'test'].includes(split) && destination,
      'Usage: node scripts/course-benchmark-data.mjs export retrieval|generation dev|test OUTPUT.jsonl');
    const rows = data[track].filter(row => row.split === split).map(projectInput);
    await writeFile(destination, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
    console.log(`Exported ${rows.length} input-only tasks. Gold labels were not exported.`);
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
