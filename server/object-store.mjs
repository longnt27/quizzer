import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

const normalizeMetadata = metadata => ({
  ...(typeof metadata?.type === 'string' && metadata.type.length <= 255 ? { type: metadata.type } : {}),
  ...(typeof metadata?.name === 'string' && metadata.name.length <= 1024 ? { name: metadata.name } : {}),
  ...(Number.isSafeInteger(metadata?.lastModified) && metadata.lastModified >= 0 ? { lastModified: metadata.lastModified } : {}),
});

export const isStoredObjectReference = value => Boolean(
  value && typeof value === 'object' && value.__quizzerObject === true
  && value.algorithm === 'sha256' && SHA256_PATTERN.test(value.sha256 ?? '')
  && Number.isSafeInteger(value.size) && value.size >= 0,
);

const referenceFor = (sha256, size, metadata) => ({
  __quizzerObject: true,
  algorithm: 'sha256',
  sha256,
  size,
  ...normalizeMetadata(metadata),
});

export class ObjectStore {
  constructor(appDataDirectory, { maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES } = {}) {
    if (typeof appDataDirectory !== 'string' || !appDataDirectory) throw new Error('Object storage requires an application-data directory');
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) throw new Error('Invalid object size limit');
    this.root = join(appDataDirectory, 'objects', 'sha256');
    this.maxObjectBytes = maxObjectBytes;
  }

  pathFor(sha256) {
    if (!SHA256_PATTERN.test(sha256 ?? '')) throw new Error('Invalid SHA-256 object id');
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  async putBuffer(data, metadata = {}) {
    if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('Object data must be binary');
    return this.#put([Buffer.from(data)], metadata, data.byteLength);
  }

  async putStream(stream, expectedSha256, metadata = {}) {
    if (!SHA256_PATTERN.test(expectedSha256 ?? '')) throw new Error('Invalid SHA-256 object id');
    const contentLength = Number(metadata.contentLength);
    if (Number.isFinite(contentLength) && (contentLength < 0 || contentLength > this.maxObjectBytes)) {
      throw new Error(`Object exceeds the ${this.maxObjectBytes}-byte limit`);
    }
    return this.#put(stream, metadata, Number.isFinite(contentLength) ? contentLength : undefined, expectedSha256);
  }

  async #put(iterable, metadata, expectedSize, expectedSha256) {
    const temporaryDirectory = join(this.root, '.incoming');
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(temporaryDirectory, `${process.pid}-${randomUUID()}.tmp`);
    const file = await open(temporaryPath, 'wx', 0o600);
    const digest = createHash('sha256');
    let size = 0;
    try {
      for await (const value of iterable) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > this.maxObjectBytes) throw new Error(`Object exceeds the ${this.maxObjectBytes}-byte limit`);
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset, null);
          if (!result.bytesWritten) throw new Error('Could not write object data');
          offset += result.bytesWritten;
        }
      }
      if (expectedSize !== undefined && size !== expectedSize) throw new Error(`Object size mismatch: expected ${expectedSize}, received ${size}`);
      await file.sync();
      await file.close();
      const sha256 = digest.digest('hex');
      if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
        const error = new Error(`Object hash mismatch: expected ${expectedSha256}, received ${sha256}`);
        error.code = 'object_hash_mismatch';
        throw error;
      }
      const destination = this.pathFor(sha256);
      await mkdir(join(this.root, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
      try {
        await rename(temporaryPath, destination);
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
        await access(destination);
        const now = new Date();
        await utimes(destination, now, now);
        await rm(temporaryPath, { force: true });
      }
      return referenceFor(sha256, size, metadata);
    } catch (error) {
      await file.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async stat(sha256) {
    const details = await stat(this.pathFor(sha256));
    if (!details.isFile()) throw new Error('Stored object is not a regular file');
    return details;
  }

  createReadStream(sha256) {
    return createReadStream(this.pathFor(sha256));
  }

  async list() {
    const result = [];
    const prefixes = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      for (const entry of await readdir(join(this.root, prefix.name), { withFileTypes: true })) {
        if (!entry.isFile() || !SHA256_PATTERN.test(entry.name) || !entry.name.startsWith(prefix.name)) continue;
        const details = await stat(join(this.root, prefix.name, entry.name));
        result.push({ sha256: entry.name, size: details.size, modifiedAt: details.mtimeMs, path: join(this.root, prefix.name, entry.name) });
      }
    }
    return result.sort((left, right) => left.sha256.localeCompare(right.sha256));
  }

  async status(referenced = new Set()) {
    const objects = await this.list();
    const referencedObjects = objects.filter(object => referenced.has(object.sha256));
    return {
      objectCount: objects.length,
      objectBytes: objects.reduce((sum, object) => sum + object.size, 0),
      referencedCount: referencedObjects.length,
      referencedBytes: referencedObjects.reduce((sum, object) => sum + object.size, 0),
      unreferencedCount: objects.length - referencedObjects.length,
      unreferencedBytes: objects.reduce((sum, object) => referenced.has(object.sha256) ? sum : sum + object.size, 0),
    };
  }

  async garbageCollect(referenced, { minimumAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    if (!(referenced instanceof Set)) throw new Error('Object garbage collection requires a reference set');
    if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) throw new Error('Invalid object retention period');
    const removed = [];
    for (const object of await this.list()) {
      if (referenced.has(object.sha256) || now - object.modifiedAt < minimumAgeMs) continue;
      await rm(object.path);
      removed.push({ sha256: object.sha256, size: object.size });
    }
    return {
      removed,
      removedCount: removed.length,
      reclaimedBytes: removed.reduce((sum, object) => sum + object.size, 0),
    };
  }
}

export const collectStoredObjectReferences = (value, result = new Set()) => {
  if (Array.isArray(value)) {
    for (const item of value) collectStoredObjectReferences(item, result);
  } else if (isStoredObjectReference(value)) {
    result.add(value.sha256);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStoredObjectReferences(item, result);
  }
  return result;
};

const decodeLegacyBlob = value => {
  if (!value || typeof value !== 'object' || value.__quizzerBlob !== true || typeof value.data !== 'string') return undefined;
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value.data);
  if (!match || match[2].length % 4 === 1) throw new Error('Invalid legacy binary payload');
  return {
    data: Buffer.from(match[2], 'base64'),
    metadata: {
      type: typeof value.type === 'string' ? value.type : match[1],
      name: value.name,
      lastModified: Number(value.lastModified),
    },
  };
};

export const materializeSerializedObjects = async (value, objectStore) => {
  if (Array.isArray(value)) return Promise.all(value.map(item => materializeSerializedObjects(item, objectStore)));
  if (!value || typeof value !== 'object') return value;
  if (isStoredObjectReference(value)) return value;
  const legacy = decodeLegacyBlob(value);
  if (legacy) return objectStore.putBuffer(legacy.data, legacy.metadata);
  return Object.fromEntries(await Promise.all(
    Object.entries(value).map(async ([key, item]) => [key, await materializeSerializedObjects(item, objectStore)]),
  ));
};

export const materializeDocumentImages = async (document, objectStore) => {
  if (!Array.isArray(document?.images)) return { document, changed: false };
  let changed = false;
  const images = await Promise.all(document.images.map(async image => {
    if (!image || typeof image !== 'object' || typeof image.data !== 'string') return image;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 === 1) {
      throw new Error(`Invalid legacy image payload: ${image.name || 'unnamed image'}`);
    }
    const { data, ...metadata } = image;
    changed = true;
    return {
      ...metadata,
      object: await objectStore.putBuffer(Buffer.from(data, 'base64'), {
        type: image.mimeType,
        name: image.name,
      }),
    };
  }));
  return { document: changed ? { ...document, images } : document, changed };
};
