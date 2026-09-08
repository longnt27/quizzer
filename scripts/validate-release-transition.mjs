import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compareSemver, parseSemver } from '../plugin-sdk/registry.mjs';

const parseDocument = (document, label) => {
  try {
    return typeof document === 'string' ? JSON.parse(document) : document;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const requireVersion = (value, label) => {
  if (typeof value !== 'string' || value !== value.trim() || !parseSemver(value)) {
    throw new Error(`${label} must be a canonical semantic version without a v prefix`);
  }
  return value;
};

export const validateReleaseTransition = ({ packageDocument, lockDocument, previousPackageDocument }) => {
  const packageJson = parseDocument(packageDocument, 'package.json');
  const packageLock = parseDocument(lockDocument, 'package-lock.json');
  const previousPackage = parseDocument(previousPackageDocument, 'previous package.json');
  const version = requireVersion(packageJson?.version, 'package.json version');
  const lockVersion = requireVersion(packageLock?.version, 'package-lock.json version');
  const lockRootVersion = requireVersion(packageLock?.packages?.['']?.version, 'package-lock.json root package version');
  const previousVersion = requireVersion(previousPackage?.version, 'previous main package.json version');

  if (lockVersion !== version || lockRootVersion !== version) {
    throw new Error(`package-lock.json versions (${lockVersion}, ${lockRootVersion}) must match package.json (${version})`);
  }
  if (compareSemver(version, previousVersion) <= 0) {
    throw new Error(`main release version ${version} must be greater than previous main version ${previousVersion}`);
  }

  return {
    version,
    previousVersion,
    tag: `v${version}`,
    channel: version.includes('-') ? 'beta' : 'stable',
  };
};

const argument = name => {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
};

const main = async () => {
  const previousRef = argument('--previous-ref');
  const expectedSha = argument('--expected-sha');
  if (!/^[a-f0-9]{40}$/.test(previousRef) || /^0{40}$/.test(previousRef)) {
    throw new Error('--previous-ref must be a nonzero full commit SHA');
  }
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('--expected-sha must be a full commit SHA');

  const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (currentSha !== expectedSha) throw new Error(`checked-out commit ${currentSha} does not match pushed main commit ${expectedSha}`);
  execFileSync('git', ['cat-file', '-e', `${previousRef}^{commit}`]);
  const previousPackageDocument = execFileSync('git', ['show', `${previousRef}:package.json`], { encoding: 'utf8' });
  const result = validateReleaseTransition({
    packageDocument: await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    lockDocument: await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    previousPackageDocument,
  });
  process.stdout.write([
    `version=${result.version}`,
    `previous_version=${result.previousVersion}`,
    `tag=${result.tag}`,
    `channel=${result.channel}`,
    '',
  ].join('\n'));
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
