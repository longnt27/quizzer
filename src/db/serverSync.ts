import type { Table } from 'dexie';
import { db, type StoredSyncChange, type SyncCollection } from './db';

type SyncStatus = 'starting' | 'synced' | 'offline' | 'syncing';
type SerializedRecord = Record<string, unknown>;
type ServerChange = {
  revision: number;
  collection: SyncCollection;
  id: string;
  data?: SerializedRecord;
  deleted: boolean;
};

const collections: SyncCollection[] = ['tests', 'documents', 'generationJobs', 'testDrafts'];
const listeners = new Set<() => void>();
let status: SyncStatus = 'starting';
let applyingRemoteChanges = false;
let syncPromise: Promise<void> | undefined;
let retryTimer: number | undefined;

const tableFor = (collection: SyncCollection): Table<Record<string, unknown>, string> =>
  db.table(collection) as Table<Record<string, unknown>, string>;

const setStatus = (next: SyncStatus) => {
  if (status === next) return;
  status = next;
  listeners.forEach(listener => listener());
};

export const serverSyncStatus = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => status,
};

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('Could not read document file'));
  reader.readAsDataURL(blob);
});

const serialize = async (value: unknown): Promise<unknown> => {
  if (value instanceof Blob) {
    return {
      __quizzerBlob: true,
      type: value.type,
      data: await blobToDataUrl(value),
      ...(value instanceof File ? { name: value.name, lastModified: value.lastModified } : {}),
    };
  }
  if (Array.isArray(value)) return Promise.all(value.map(serialize));
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await serialize(item)])));
  }
  return value;
};

const deserialize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(deserialize);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (object.__quizzerBlob === true && typeof object.data === 'string') {
      const [header, encoded = ''] = object.data.split(',', 2);
      const type = typeof object.type === 'string' ? object.type : /^data:([^;]+)/.exec(header)?.[1] || '';
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return typeof object.name === 'string'
        ? new File([bytes], object.name, { type, lastModified: Number(object.lastModified) || Date.now() })
        : new Blob([bytes], { type });
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, deserialize(item)]));
  }
  return value;
};

const markChanged = (collection: SyncCollection, id: string, deleted: boolean) => {
  if (applyingRemoteChanges) return;
  const change: StoredSyncChange = {
    key: `${collection}:${id}`,
    collection,
    id,
    deleted,
    changedAt: Date.now(),
  };
  void db.syncChanges.put(change).then(() => scheduleSync(250));
};

const installHooks = () => {
  for (const collection of collections) {
    const table = tableFor(collection);
    table.hook('creating', function (id) {
      this.onsuccess = () => markChanged(collection, String(id), false);
    });
    table.hook('updating', function (_changes, id) {
      this.onsuccess = () => markChanged(collection, String(id), false);
    });
    table.hook('deleting', function (id) {
      this.onsuccess = () => markChanged(collection, String(id), true);
    });
  }
};

const outgoingChanges = async (bootstrap: boolean) => {
  if (bootstrap) {
    const result = [];
    for (const collection of collections) {
      for (const record of await tableFor(collection).toArray()) {
        result.push({ collection, id: String(record.id ?? record.testId), data: await serialize(record) });
      }
    }
    return result;
  }

  const pending = await db.syncChanges.toArray();
  return Promise.all(pending.map(async change => {
    const record = change.deleted ? undefined : await tableFor(change.collection).get(change.id);
    return {
      collection: change.collection,
      id: change.id,
      deleted: change.deleted || !record,
      data: record ? await serialize(record) : undefined,
      changedAt: change.changedAt,
    };
  }));
};

const applyServerChanges = async (changes: ServerChange[], cursor: number, sent: Array<{ collection: SyncCollection; id: string; changedAt?: number }>) => {
  applyingRemoteChanges = true;
  try {
    await db.transaction('rw', [...collections.map(tableFor), db.syncChanges, db.syncState], async () => {
      for (const change of changes) {
        const table = tableFor(change.collection);
        if (change.deleted) await table.delete(change.id);
        else if (change.data) await table.put(deserialize(change.data) as Record<string, unknown>);
      }
      for (const item of sent) {
        const marker = await db.syncChanges.get(`${item.collection}:${item.id}`);
        if (marker && marker.changedAt === item.changedAt) await db.syncChanges.delete(marker.key);
      }
      await db.syncState.put({ id: 'server', cursor, bootstrapped: true });
    });
  } finally {
    applyingRemoteChanges = false;
  }
};

const runSync = async () => {
  const state = await db.syncState.get('server');
  const bootstrap = !state?.bootstrapped;
  const outgoing = await outgoingChanges(bootstrap);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch('/api/storage/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: state?.cursor ?? 0, bootstrap, changes: outgoing }),
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload.changes) || !Number.isSafeInteger(payload.cursor)) {
    throw new Error(payload.error || `Server storage failed (${response.status})`);
  }
  await applyServerChanges(payload.changes, payload.cursor, outgoing);
};

export const syncNow = () => {
  if (syncPromise) return syncPromise;
  setStatus('syncing');
  syncPromise = runSync()
    .then(() => setStatus('synced'))
    .catch(error => {
      console.warn('Quizzer server sync is unavailable; changes remain in IndexedDB.', error);
      setStatus('offline');
    })
    .finally(() => { syncPromise = undefined; });
  return syncPromise;
};

function scheduleSync(delay = 0) {
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    void syncNow();
  }, delay);
}

export const initializeServerSync = async () => {
  installHooks();
  await syncNow();
  window.addEventListener('online', () => scheduleSync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync();
  });
  window.setInterval(() => void syncNow(), 5_000);
};
