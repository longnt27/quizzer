import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialVault } from '../desktop/credential-vault.mjs';

const fakeEncryption = (available = true, backend = 'unknown') => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: value => Buffer.from(`encrypted:${[...value].reverse().join('')}`),
  decryptString: value => [...value.toString().replace(/^encrypted:/, '')].reverse().join(''),
});

test('encrypts, updates, lists, and deletes remembered credentials without plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-credentials-'));
  const path = join(directory, 'credentials.json');
  try {
    const vault = new CredentialVault(path, fakeEncryption());
    assert.equal(vault.status().available, true);
    await Promise.all([
      vault.set('openai', 'secret-openai-key'),
      vault.set('anthropic', 'secret-anthropic-key'),
    ]);
    assert.deepEqual(await vault.list(), { openai: 'secret-openai-key', anthropic: 'secret-anthropic-key' });
    const stored = await readFile(path, 'utf8');
    assert.doesNotMatch(stored, /secret-(?:openai|anthropic)-key/);
    await vault.delete('openai');
    assert.deepEqual(await vault.list(), { anthropic: 'secret-anthropic-key' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unknown providers, invalid values, and insecure Linux fallback storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-credentials-'));
  try {
    const vault = new CredentialVault(join(directory, 'credentials.json'), fakeEncryption(true, 'basic_text'));
    assert.equal(vault.status().available, false);
    assert.throws(() => vault.set('openai', 'secret'), /secure Linux keyring/);
    assert.deepEqual(await vault.list(), {});
    assert.throws(() => vault.set('unknown', 'secret'), /Unsupported credential provider/);
    assert.throws(() => vault.set('openai', ''), /Credential value is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
