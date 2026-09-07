import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const testFiles = (await readdir('test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name));

if (!testFiles.length) throw new Error('No test files were found');

// Keep critical modules isolated: aggregate coverage can mask an untested
// sibling. Baselines are measured floors at introduction; raise them as gaps
// close. The target for every entry is >=90% lines and >=80% branches.
const criticalModules = [
  { module: 'server/settings.mjs', baseline: [98, 90] }, // config
  { module: 'server/storage.mjs', baseline: [96, 73] }, // migrations/accounting/jobs
  { module: 'server/index-jobs.mjs', baseline: [100, 87] }, // indexing
  { module: 'server/retrieval-index.mjs', baseline: [93, 80] }, // retrieval
  { module: 'server/plugin-generation.mjs', baseline: [100, 88] }, // plugins
  { module: 'server/builtin-provider-generation.mjs', baseline: [100, 65] }, // provider routing
  { module: 'server/provider-policy.mjs', baseline: [90, 70] }, // provider policy
  { module: 'server/openai-compatible-generation.mjs', baseline: [92, 84] }, // provider adapter
  { module: 'server/generation-validation.mjs', baseline: [80, 60] }, // validators
  { module: 'server/generation-cost.mjs', baseline: [83, 72] }, // cost/accounting
  { module: 'server/generation-worker.mjs', baseline: [80, 60] }, // job transitions
];

const runModule = entry => new Promise((resolve, reject) => {
  const args = ['--test', '--experimental-test-coverage',
    `--test-coverage-include=${entry.module}`, '--test-coverage-lines=0', '--test-coverage-branches=0', ...testFiles];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.once('error', reject);
  child.once('exit', code => {
    if (code !== 0) return reject(new Error(`${entry.module} test suite failed`));
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
  });
});

try {
  for (const entry of criticalModules) await runModule(entry);
} catch (error) {
  process.stderr.write(`Coverage gate failed: ${error.message}\n`);
  process.exitCode = 1;
}
