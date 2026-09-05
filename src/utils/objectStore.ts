import type { StoredObjectReference } from '../db/db';
import { serviceFetch } from './serviceApi';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const sha256 = async (data: ArrayBuffer) => {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const isStoredObjectReference = (value: unknown): value is StoredObjectReference => Boolean(
  value && typeof value === 'object'
  && (value as StoredObjectReference).__quizzerObject === true
  && (value as StoredObjectReference).algorithm === 'sha256'
  && SHA256_PATTERN.test((value as StoredObjectReference).sha256)
  && Number.isSafeInteger((value as StoredObjectReference).size)
  && (value as StoredObjectReference).size >= 0,
);

export const storeBlob = async (blob: Blob): Promise<StoredObjectReference> => {
  const data = await blob.arrayBuffer();
  const digest = await sha256(data);
  const response = await serviceFetch(`/api/v1/objects/${digest}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; object?: StoredObjectReference };
  if (!response.ok || !isStoredObjectReference(payload.object) || payload.object.sha256 !== digest || payload.object.size !== blob.size) {
    throw new Error(payload.error || `Could not save the original file (${response.status})`);
  }
  return {
    ...payload.object,
    type: blob.type || payload.object.type,
    ...(blob instanceof File ? { name: blob.name, lastModified: blob.lastModified } : {}),
  };
};

export const loadStoredBlob = async (value: Blob | StoredObjectReference): Promise<Blob> => {
  if (value instanceof Blob) return value;
  if (!isStoredObjectReference(value)) throw new Error('The original-file reference is invalid');
  const response = await serviceFetch(`/api/v1/objects/${value.sha256}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Could not load the original file (${response.status})`);
  }
  const data = await response.arrayBuffer();
  if (data.byteLength !== value.size || await sha256(data) !== value.sha256) {
    throw new Error('The original file failed its integrity check');
  }
  return value.name
    ? new File([data], value.name, { type: value.type, lastModified: value.lastModified })
    : new Blob([data], { type: value.type });
};
