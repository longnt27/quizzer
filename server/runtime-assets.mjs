import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getAsset, isSea } from 'node:sea';

export const runningAsSingleExecutable = isSea();

const sha256 = value => createHash('sha256').update(value).digest('hex');

export const readRuntimeText = async (key, sourceUrl) => runningAsSingleExecutable
  ? getAsset(key, 'utf8')
  : readFile(sourceUrl, 'utf8');

export const materializeRuntimeAsset = async (key, destination, { executable = false } = {}) => {
  if (!runningAsSingleExecutable) throw new Error('Embedded runtime assets are available only in a Quizzer executable');
  const data = Buffer.from(getAsset(key));
  const expectedHash = sha256(data);
  const current = await readFile(destination).catch(error => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (current && sha256(current) === expectedHash) return destination;

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, data, { mode: executable ? 0o700 : 0o600 });
  await rm(destination, { force: true });
  await rename(temporaryPath, destination);
  await chmod(destination, executable ? 0o700 : 0o600).catch(error => {
    if (process.platform !== 'win32') throw error;
  });
  return destination;
};
