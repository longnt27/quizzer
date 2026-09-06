import { resolve } from 'node:path';
import { scanProjectLicenses } from '../release/licenses.mjs';

const projects = [resolve('.'), resolve('landing')];
let failed = false;

for (const project of projects) {
  const result = await scanProjectLicenses(project);
  const label = project === projects[0] ? 'application' : 'landing';
  process.stdout.write(`${label}: checked ${result.packages} dependency packages across ${Object.keys(result.licenses).length} approved license expressions\n`);
  for (const violation of result.violations) {
    failed = true;
    process.stderr.write(`${label}: ${violation.name}@${violation.version ?? 'unknown'} ${violation.reason}\n`);
  }
}

if (failed) process.exitCode = 1;
