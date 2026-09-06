import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ALLOWED_LICENSE_IDS = Object.freeze(new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT',
  'MPL-2.0',
  'Python-2.0',
  'WTFPL',
]));

const reviewedPlatformBinaryLicense = packageName => {
  if (packageName.startsWith('@rollup/rollup-')) return 'MIT';
  if (packageName.startsWith('@napi-rs/canvas-')) return 'MIT';
  return undefined;
};

export const licenseIdentifiers = expression => typeof expression === 'string'
  ? (expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? []).filter(identifier => !['AND', 'OR', 'WITH'].includes(identifier))
  : [];

export const isAllowedLicense = expression => {
  const identifiers = licenseIdentifiers(expression);
  return identifiers.length > 0 && identifiers.every(identifier => ALLOWED_LICENSE_IDS.has(identifier));
};

const packageNameFrom = lockPath => {
  const marker = 'node_modules/';
  const offset = lockPath.lastIndexOf(marker);
  return offset >= 0 ? lockPath.slice(offset + marker.length) : lockPath;
};

const installedLicense = async (projectDirectory, lockPath) => {
  try {
    const packageManifest = JSON.parse(await readFile(join(projectDirectory, lockPath, 'package.json'), 'utf8'));
    if (typeof packageManifest.license === 'string') return packageManifest.license;
    if (typeof packageManifest.license?.type === 'string') return packageManifest.license.type;
    const legacyLicenses = Array.isArray(packageManifest.licenses)
      ? packageManifest.licenses.map(item => typeof item === 'string' ? item : item?.type).filter(Boolean)
      : [];
    return legacyLicenses.length ? [...new Set(legacyLicenses)].join(' OR ') : undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Could not inspect ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const auditPackageLicenses = packages => {
  const violations = [];
  const licenses = new Map();
  for (const package_ of packages) {
    if (!package_.license) {
      violations.push({ ...package_, reason: 'license metadata is missing' });
      continue;
    }
    if (!isAllowedLicense(package_.license)) {
      violations.push({ ...package_, reason: `license is not approved: ${package_.license}` });
      continue;
    }
    licenses.set(package_.license, (licenses.get(package_.license) ?? 0) + 1);
  }
  return {
    packages: packages.length,
    licenses: Object.fromEntries([...licenses].sort(([left], [right]) => left.localeCompare(right))),
    violations,
  };
};

export const scanProjectLicenses = async projectDirectory => {
  const lockPath = join(projectDirectory, 'package-lock.json');
  let lock;
  try { lock = JSON.parse(await readFile(lockPath, 'utf8')); }
  catch (error) { throw new Error(`Could not read ${lockPath}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error(`${lockPath} does not contain npm package metadata`);
  }

  const packages = [];
  for (const [lockPackagePath, metadata] of Object.entries(lock.packages)) {
    if (!lockPackagePath) continue;
    if (metadata.dev) continue;
    const name = packageNameFrom(lockPackagePath);
    const license = typeof metadata.license === 'string'
      ? metadata.license
      : await installedLicense(projectDirectory, lockPackagePath) ?? reviewedPlatformBinaryLicense(name);
    packages.push({ name, version: metadata.version, license, optional: metadata.optional === true });
  }
  return auditPackageLicenses(packages);
};
