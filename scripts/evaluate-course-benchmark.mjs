import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRun, makeReviewPacket, scoreRun, compareReports } from '../eval/course-benchmark/evaluation.mjs';
import { collectRetrieval } from '../eval/course-benchmark/service-collector.mjs';

const usage = `Course benchmark evaluator (offline unless collect is explicitly selected)
  collect CONFIG.json RUN.json --acknowledge-provider-access [--allow-candidate]
  record-generation CONFIG.json PREDICTIONS.jsonl RUN.json [--allow-candidate]
  review RUN.json REVIEWS.json
  score RUN.json REPORT.json [REVIEWS.json] [--allow-candidate]
  compare BASELINE_REPORT.json CANDIDATE_REPORT.json COMPARISON.json

CONFIG: split, sourceLockPath, system{name,gitCommit,generator?,settingsFingerprint?}.
collect additionally needs baseUrl, documentMap and QUIZZER_BENCHMARK_TOKEN.
No provider is selected, configured, paid for, or invoked by the offline commands.`;
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const write = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

try {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  if ([...flags].some(f => !['--help', '--allow-candidate', '--acknowledge-provider-access'].includes(f))) throw new Error('Unknown flag');
  const [command, ...paths] = args.filter(a => !a.startsWith('--'));
  if (!command || flags.has('--help')) {
    console.log(usage);
  } else {
    const arity = { collect: [2], 'record-generation': [3], review: [2], score: [2, 3], compare: [3] };
    if (!arity[command]?.includes(paths.length)) throw new Error(usage);
    if (command === 'compare') {
      await write(paths[2], compareReports(await read(paths[0]), await read(paths[1])));
    } else {
      const { loadDataset, readJsonLines } = await import('../eval/course-benchmark/dataset.mjs');
      const dataset = await loadDataset();
      const allowCandidate = flags.has('--allow-candidate');
      if (command === 'collect' || command === 'record-generation') {
        if (!allowCandidate && dataset.status !== 'reviewed') throw new Error('Candidate dataset requires --allow-candidate');
        const config = await read(paths[0]);
        const sourceLock = await read(resolve(dirname(resolve(paths[0])), config.sourceLockPath));
        if (command === 'collect') {
          await write(paths[1], await collectRetrieval(dataset, config, { sourceLock, allowCandidate,
            token: process.env.QUIZZER_BENCHMARK_TOKEN, acknowledgeProviderAccess: flags.has('--acknowledge-provider-access') }));
        } else {
          await write(paths[2], createRun(dataset, { track: 'generation', split: config.split, sourceLock,
            system: config.system, predictions: await readJsonLines(paths[1]) }));
        }
      } else {
        const run = await read(paths[0]);
        await write(paths[1], command === 'review' ? makeReviewPacket(dataset, run)
          : scoreRun(dataset, run, { allowCandidate, reviews: paths[2] ? await read(paths[2]) : undefined }));
      }
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
