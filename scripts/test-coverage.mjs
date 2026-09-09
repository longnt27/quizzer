import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { coverageArgumentsForAttempt, isRetryableCoverageFailure, MAX_COVERAGE_ATTEMPTS } from './coverage-retry.mjs';

const testFiles = (await readdir('test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name));

if (!testFiles.length) throw new Error('No test files were found');
const coverageRoots = [
  'server/*.mjs',
  'plugin-sdk/*.mjs',
  'release/*.mjs',
  'desktop/background-policy.mjs',
  'desktop/credential-vault.mjs',
  'desktop/security.mjs',
  'desktop/service-process.mjs',
  'desktop/updater.mjs',
  'desktop/updater-ipc.mjs',
];

// Keep critical modules isolated: aggregate coverage can mask an untested
// sibling. Baselines are measured floors at introduction; raise them as gaps
// close. The target for every entry is >=90% lines and >=80% branches.
const criticalModules = [
  { module: 'desktop/background-policy.mjs', baseline: [100, 100] }, // durable tray work
  { module: 'desktop/credential-vault.mjs', baseline: [95, 91] }, // secrets
  { module: 'desktop/security.mjs', baseline: [100, 100] }, // renderer boundaries
  { module: 'desktop/service-process.mjs', baseline: [100, 90] }, // service supervision
  { module: 'server/settings.mjs', baseline: [99, 92] }, // config
  { module: 'server/storage.mjs', baseline: [99, 86] }, // migrations/accounting/jobs
  { module: 'server/index-jobs.mjs', baseline: [100, 87] }, // indexing
  { module: 'server/retrieval-index.mjs', baseline: [93, 80] }, // retrieval
  { module: 'server/plugin-generation.mjs', baseline: [100, 88] }, // plugins
  { module: 'server/builtin-provider-generation.mjs', baseline: [100, 86] }, // provider routing
  { module: 'server/provider-policy.mjs', baseline: [100, 100] }, // provider policy
  { module: 'server/openai-compatible-generation.mjs', baseline: [94, 86] }, // provider adapter
  { module: 'server/generation-validation.mjs', baseline: [99, 89] }, // validators
  { module: 'server/generation-cost.mjs', baseline: [100, 83] }, // cost/accounting
  { module: 'server/generation-worker.mjs', baseline: [100, 87] }, // job transitions
];

const runTestsOnce = (args, label) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.once('error', error => reject(new Error(`${label}: could not start tests: ${error.message}`)));
  child.once('exit', (code, signal) => resolve({ code, signal, output }));
});

const runTests = async (args, label) => {
  for (let attempt = 1; attempt <= MAX_COVERAGE_ATTEMPTS; attempt += 1) {
    // Node's experimental collector can occasionally read a partial report
    // while many isolated test processes finish together. Keep the normal
    // fast path parallel, then serialize a retry to avoid repeating the race.
    const result = await runTestsOnce(coverageArgumentsForAttempt(args, attempt), label);
    if (!result.signal && result.code === 0) return result.output;

    const retryable = isRetryableCoverageFailure({ attempt, signal: result.signal, output: result.output });
    if (retryable) {
      process.stderr.write(`${label}: Node produced an incomplete experimental coverage report; retrying (${attempt}/${MAX_COVERAGE_ATTEMPTS}).\n`);
      continue;
    }

    throw new Error(`${label} failed${result.signal ? ` (${result.signal})` : ''}:\n${result.output}`);
  }
  throw new Error(`${label} failed after retry`);
};

const runModule = entry => new Promise((resolve, reject) => {
  const args = ['--test', '--experimental-test-coverage',
    `--test-coverage-include=${entry.module}`, '--test-coverage-lines=0', '--test-coverage-branches=0', ...testFiles];
  runTests(args, entry.module).then(output => {
    const file = basename(entry.module).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = output.match(new RegExp(`#\\s+${file}\\s+\\|\\s+([\\d.]+)\\s+\\|\\s+([\\d.]+)`));
    if (!match) return reject(new Error(`Coverage report did not include ${entry.module}`));
    const lines = Number(match[1]);
    const branches = Number(match[2]);
    process.stdout.write(`${entry.module}: ${lines}% lines / ${branches}% branches\n`);
    if (lines < entry.baseline[0] || branches < entry.baseline[1]) {
      return reject(new Error(`${entry.module} regressed: ${lines}%/${branches}% (baseline ${entry.baseline.join('%/') }%)`));
    }
    if (lines < 90 || branches < 80) process.stderr.write(
      `RATCHET: ${entry.module} is ${lines}% lines / ${branches}% branches; target is 90% / 80%.\n`,
    );
    resolve();
  }).catch(reject);
});

try {
  await runTests([
    '--test', '--experimental-test-coverage',
    ...coverageRoots.map(pattern => `--test-coverage-include=${pattern}`),
    '--test-coverage-lines=90', '--test-coverage-branches=80', ...testFiles,
  ], 'Aggregate coverage gate');
  process.stdout.write('Aggregate coverage gate: passed (90% lines / 80% branches)\n');
  for (const entry of criticalModules) await runModule(entry);
} catch (error) {
  process.stderr.write(`Coverage gate failed: ${error.message}\n`);
  process.exitCode = 1;
}
