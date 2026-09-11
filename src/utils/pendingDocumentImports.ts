import type { RcFile } from 'antd/es/upload';
import type { StoredDocument } from '../db/db';

export interface PendingDocumentImport {
  id: string;
  file: RcFile;
  name: string;
  tags: string[];
  status: 'extracting' | 'ready' | 'error';
  stage?: string;
  error?: string;
  extracted?: Pick<StoredDocument,
    'content' | 'pageCount' | 'images' | 'parserVersion' | 'extractionSchemaVersion' | 'extractedAt' | 'extractionContentHash'>;
}

let items: PendingDocumentImport[] = [];
let snapshot = items;
let activitySnapshot = { count: 0, running: 0, attention: 0 };
const listeners = new Set<() => void>();

const emit = () => {
  snapshot = items;
  const running = snapshot.filter(item => item.status === 'extracting').length;
  const attention = snapshot.filter(item => item.status === 'error').length;
  activitySnapshot = { count: running + attention, running, attention };
  for (const listener of listeners) listener();
};

export const pendingDocumentImports = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot() {
    return snapshot;
  },
  add(item: PendingDocumentImport) {
    items = [...items, item];
    emit();
  },
  update(id: string, changes: Partial<PendingDocumentImport>) {
    items = items.map(item => item.id === id ? { ...item, ...changes } : item);
    emit();
  },
  remove(id: string) {
    items = items.filter(item => item.id !== id);
    emit();
  },
  removeMany(ids: string[]) {
    const removed = new Set(ids);
    items = items.filter(item => !removed.has(item.id));
    emit();
  },
  replaceTags(transform: (item: PendingDocumentImport) => string[]) {
    items = items.map(item => ({ ...item, tags: transform(item) }));
    emit();
  },
};

export const pendingDocumentImportActivity = {
  subscribe: pendingDocumentImports.subscribe,
  getSnapshot: () => activitySnapshot,
};
