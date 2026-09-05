import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const hashFile = path => new Promise((resolve, reject) => {
  const digest = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', chunk => digest.update(chunk));
  input.once('error', reject);
  input.once('end', () => resolve(digest.digest('hex')));
});

const inspectFile = async path => {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${path}`);
  return { size: details.size, sha256: await hashFile(path) };
};

const prepareDestination = async destination => {
  try {
    const details = await lstat(destination);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Backup destination must be a directory');
    if ((await readdir(destination)).length) throw new Error('Backup destination must be empty');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(destination, { recursive: true, mode: 0o700 });
  }
};

const secureFile = path => chmod(path, 0o600).catch(error => {
  if (process.platform !== 'win32') throw error;
});

const validateManifest = manifest => {
  if (!manifest || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.createdAt)) throw new Error('Unsupported or invalid backup manifest');
  if (!manifest.database || manifest.database.path !== 'quizzer.sqlite') throw new Error('Backup manifest has an invalid database entry');
  if (!Array.isArray(manifest.objects)) throw new Error('Backup manifest has an invalid object collection');
  const ids = new Set();
  for (const object of manifest.objects) {
    if (!SHA256_PATTERN.test(object?.sha256 ?? '') || !Number.isSafeInteger(object?.size) || object.size < 0) {
      throw new Error('Backup manifest has an invalid object entry');
    }
    if (ids.has(object.sha256)) throw new Error(`Backup manifest repeats object ${object.sha256}`);
    ids.add(object.sha256);
    const expectedPath = `objects/sha256/${object.sha256.slice(0, 2)}/${object.sha256}`;
    if (object.path !== expectedPath) throw new Error(`Backup manifest has an unsafe object path for ${object.sha256}`);
  }
  if (manifest.config && manifest.config.path !== 'config.jsonc') throw new Error('Backup manifest has an invalid configuration entry');
  return manifest;
};

const verifyEntry = async (directory, entry, label) => {
  if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256_PATTERN.test(entry.sha256 ?? '')) {
    throw new Error(`Backup manifest has invalid ${label} metadata`);
  }
  const actual = await inspectFile(join(directory, ...entry.path.split('/')));
  if (actual.size !== entry.size) throw new Error(`${label} size mismatch`);
  if (actual.sha256 !== entry.sha256) throw new Error(`${label} hash mismatch`);
};

export const createBackup = async ({ destination, database, objectStore, settingsFile }) => {
  if (typeof destination !== 'string' || !destination) throw new Error('A backup destination is required');
  await prepareDestination(destination);
  const databasePath = join(destination, 'quizzer.sqlite');
  await database.backupDatabase(databasePath);
  await secureFile(databasePath);
  const databaseEntry = { path: 'quizzer.sqlite', ...await inspectFile(databasePath) };

  let configEntry;
  try {
    const config = await readFile(settingsFile);
    const configPath = join(destination, 'config.jsonc');
    await writeFile(configPath, config, { mode: 0o600, flag: 'wx' });
    configEntry = { path: 'config.jsonc', ...await inspectFile(configPath) };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const objects = [];
  for (const object of await objectStore.list()) {
    const relativePath = `objects/sha256/${object.sha256.slice(0, 2)}/${object.sha256}`;
    const destinationPath = join(destination, ...relativePath.split('/'));
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await copyFile(object.path, destinationPath);
    await secureFile(destinationPath);
    const copied = await inspectFile(destinationPath);
    if (copied.sha256 !== object.sha256 || copied.size !== object.size) throw new Error(`Object ${object.sha256} changed while it was backed up`);
    objects.push({ path: relativePath, sha256: object.sha256, size: object.size });
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: Date.now(),
    database: databaseEntry,
    ...(configEntry ? { config: configEntry } : {}),
    objects,
    totals: {
      objectCount: objects.length,
      objectBytes: objects.reduce((sum, object) => sum + object.size, 0),
    },
  };
  await writeFile(join(destination, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return manifest;
};

export const verifyBackup = async directory => {
  const manifest = validateManifest(JSON.parse(await readFile(join(directory, 'backup-manifest.json'), 'utf8')));
  await verifyEntry(directory, manifest.database, 'Database');
  if (manifest.config) await verifyEntry(directory, manifest.config, 'Configuration');
  for (const object of manifest.objects) await verifyEntry(directory, object, `Object ${object.sha256}`);
  const objectBytes = manifest.objects.reduce((sum, object) => sum + object.size, 0);
  if (manifest.totals?.objectCount !== manifest.objects.length || manifest.totals?.objectBytes !== objectBytes) {
    throw new Error('Backup object totals do not match its manifest');
  }
  return { valid: true, manifest };
};
