import type { Table } from 'dexie';
import { db, type StoredSyncChange, type SyncCollection } from './db';

type SyncStatus = 'starting' | 'synced' | 'offline' | 'syncing';
type SyncPhase = 'idle' | 'preparing' | 'uploading' | 'receiving' | 'applying' | 'complete' | 'error';
export interface ServerSyncSnapshot {
  status: SyncStatus;
  phase: SyncPhase;
  percent: number;
  completed: number;
  total: number;
  pending: number;
  detail: string;
  error?: string;
  lastSyncedAt?: number;
}
type SerializedRecord = Record<string, unknown>;
type ServerChange = {
  revision: number;
  collection: SyncCollection;
  id: string;
  data?: SerializedRecord;
  deleted: boolean;
};
type OutgoingChange = {
  collection: SyncCollection;
  id: string;
  data?: unknown;
  deleted?: boolean;
  changedAt?: number;
};

const collections: SyncCollection[] = ['tests', 'documents', 'generationJobs', 'testDrafts'];
const listeners = new Set<() => void>();
let snapshot: ServerSyncSnapshot = {
  status: 'starting', phase: 'idle', percent: 0, completed: 0, total: 0, pending: 0,
  detail: 'Connecting to the server library…',
};
let applyingRemoteChanges = false;
let syncPromise: Promise<void> | undefined;
let retryTimer: number | undefined;

const tableFor = (collection: SyncCollection): Table<Record<string, unknown>, string> =>
  db.table(collection) as Table<Record<string, unknown>, string>;

const updateSnapshot = (change: Partial<ServerSyncSnapshot>) => {
  snapshot = { ...snapshot, ...change };
  listeners.forEach(listener => listener());
};

export const serverSyncStatus = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,
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

const outgoingChanges = async (bootstrap: boolean): Promise<OutgoingChange[]> => {
  if (bootstrap) {
    const records = await Promise.all(collections.map(async collection => ({ collection, records: await tableFor(collection).toArray() })));
    const total = records.reduce((sum, item) => sum + item.records.length, 0);
    updateSnapshot({ phase: 'preparing', percent: total ? 0 : 15, completed: 0, total, pending: total, detail: 'Preparing the existing browser library…' });
    const result: OutgoingChange[] = [];
    let completed = 0;
    for (const { collection, records: tableRecords } of records) {
      for (const record of tableRecords) {
        result.push({ collection, id: String(record.id ?? record.testId), data: await serialize(record) });
        completed += 1;
        updateSnapshot({ completed, percent: total ? Math.round(completed / total * 15) : 15 });
      }
    }
    return result;
  }

  const pending = await db.syncChanges.toArray();
  updateSnapshot({ phase: 'preparing', percent: pending.length ? 0 : 15, completed: 0, total: pending.length, pending: pending.length, detail: pending.length ? 'Preparing local changes…' : 'Checking for changes from other machines…' });
  const result: OutgoingChange[] = [];
  for (const [index, change] of pending.entries()) {
    const record = change.deleted ? undefined : await tableFor(change.collection).get(change.id);
    result.push({
      collection: change.collection,
      id: change.id,
      deleted: change.deleted || !record,
      data: record ? await serialize(record) : undefined,
      changedAt: change.changedAt,
    });
    updateSnapshot({ completed: index + 1, percent: pending.length ? Math.round((index + 1) / pending.length * 15) : 15 });
  }
  return result;
};

const applyServerChanges = async (
  changes: ServerChange[],
  cursor: number,
  sent: Array<{ collection: SyncCollection; id: string; changedAt?: number }>,
  bootstrapped: boolean,
) => {
  applyingRemoteChanges = true;
  try {
    await db.transaction('rw', [...collections.map(tableFor), db.syncChanges, db.syncState], async () => {
      for (const change of changes) {
        const table = tableFor(change.collection);
        if (change.deleted) await table.delete(change.id);
        else if (change.data) await table.put(deserialize(change.data) as Record<string, unknown>);
        const completed = changes.indexOf(change) + 1;
        updateSnapshot({ completed, total: changes.length, percent: 75 + Math.round(completed / Math.max(changes.length, 1) * 24) });
      }
      for (const item of sent) {
        const marker = await db.syncChanges.get(`${item.collection}:${item.id}`);
        if (marker && marker.changedAt === item.changedAt) await db.syncChanges.delete(marker.key);
      }
      await db.syncState.put({ id: 'server', cursor, bootstrapped });
    });
  } finally {
    applyingRemoteChanges = false;
  }
};

const postSync = (body: string, batch: number, batchCount: number) => new Promise<{ cursor: number; changes: ServerChange[] }>((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('POST', '/api/storage/sync');
  request.setRequestHeader('Content-Type', 'application/json');
  request.timeout = 5 * 60_000;
  request.upload.onprogress = event => {
    const fraction = event.lengthComputable ? event.loaded / Math.max(event.total, 1) : 0;
    updateSnapshot({
      phase: 'uploading', percent: 15 + Math.round(fraction * 50), completed: event.loaded, total: event.total || body.length,
      detail: `Uploading batch ${batch} of ${batchCount} to SQLite…`,
    });
  };
  request.onprogress = event => {
    updateSnapshot({
      phase: 'receiving', percent: event.lengthComputable ? 65 + Math.round(event.loaded / Math.max(event.total, 1) * 10) : 70,
      completed: event.loaded, total: event.total, detail: 'Receiving the shared library…',
    });
  };
  request.onerror = () => reject(new Error('Cannot reach the Quizzer server'));
  request.ontimeout = () => reject(new Error('Server sync timed out'));
  request.onload = () => {
    let payload: { cursor?: number; changes?: ServerChange[]; error?: string } = {};
    try { payload = JSON.parse(request.responseText); }
    catch { reject(new Error('The server returned an invalid sync response')); return; }
    if (request.status < 200 || request.status >= 300 || !Array.isArray(payload.changes) || !Number.isSafeInteger(payload.cursor)) {
      reject(new Error(payload.error || `Server storage failed (${request.status})`));
      return;
    }
    resolve({ cursor: payload.cursor as number, changes: payload.changes });
  };
  request.send(body);
});

const runSync = async () => {
  const state = await db.syncState.get('server');
  const bootstrap = !state?.bootstrapped;
  const outgoing = await outgoingChanges(bootstrap);
  const batches: typeof outgoing[] = [];
  let currentBatch: typeof outgoing = [];
  let currentBytes = 0;
  const targetBytes = 16 * 1024 * 1024;
  for (const change of outgoing) {
    const bytes = JSON.stringify(change).length;
    if (currentBatch.length && currentBytes + bytes > targetBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(change);
    currentBytes += bytes;
  }
  if (currentBatch.length || !batches.length) batches.push(currentBatch);

  let cursor = state?.cursor ?? 0;
  for (const [index, batch] of batches.entries()) {
    const batchNumber = index + 1;
    updateSnapshot({ phase: 'uploading', percent: 15, completed: 0, total: 0, detail: `Uploading batch ${batchNumber} of ${batches.length} to SQLite…` });
    const payload = await postSync(JSON.stringify({ cursor, bootstrap, changes: batch }), batchNumber, batches.length);
    updateSnapshot({
      phase: 'applying', percent: 75, completed: 0, total: payload.changes.length,
      detail: payload.changes.length ? `Applying server changes from batch ${batchNumber} of ${batches.length}…` : 'Library is already up to date.',
    });
    cursor = payload.cursor;
    await applyServerChanges(payload.changes, cursor, batch, batchNumber === batches.length);
  }
};

export const syncNow = () => {
  if (syncPromise) return syncPromise;
  updateSnapshot({ status: 'syncing', error: undefined });
  syncPromise = runSync()
    .then(async () => updateSnapshot({
      status: 'synced', phase: 'complete', percent: 100, completed: 0, total: 0,
      pending: await db.syncChanges.count(), detail: 'Everything is saved on the server.', lastSyncedAt: Date.now(), error: undefined,
    }))
    .catch(error => {
      console.warn('Quizzer server sync is unavailable; changes remain in IndexedDB.', error);
      void db.syncChanges.count().then(pending => updateSnapshot({
        status: 'offline', phase: 'error', pending, detail: 'Changes are safe in this browser and will retry automatically.',
        error: error instanceof Error ? error.message : 'Server sync failed',
      }));
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
