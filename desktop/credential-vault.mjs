import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CREDENTIAL_PROVIDERS = Object.freeze(['gemini', 'anthropic', 'openai', 'openrouter', 'deepseek']);

export class CredentialVault {
  constructor(filePath, encryption) {
    this.filePath = filePath;
    this.encryption = encryption;
    this.mutation = Promise.resolve();
  }

  status() {
    const backend = this.encryption.getSelectedStorageBackend();
    const available = this.encryption.isEncryptionAvailable() && backend !== 'basic_text';
    return {
      available,
      backend,
      message: available ? 'Credentials are protected by the operating system.'
        : backend === 'basic_text' ? 'A secure Linux keyring is required to remember credentials.'
          : 'Operating-system credential encryption is unavailable.',
    };
  }

  validateProvider(provider) {
    if (!CREDENTIAL_PROVIDERS.includes(provider)) throw new Error('Unsupported credential provider');
  }

  async readEncrypted() {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.entries(value).some(([provider, encrypted]) => !CREDENTIAL_PROVIDERS.includes(provider) || typeof encrypted !== 'string')) {
        throw new Error('The credential vault is invalid');
      }
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async writeEncrypted(vault) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  list() {
    if (!this.status().available) return Promise.resolve({});
    return this.readEncrypted().then(vault => Object.fromEntries(Object.entries(vault).map(([provider, encrypted]) => [
      provider,
      this.encryption.decryptString(Buffer.from(encrypted, 'base64')),
    ])));
  }

  set(provider, value) {
    this.validateProvider(provider);
    if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw new Error('Credential value is invalid');
    const status = this.status();
    if (!status.available) throw new Error(status.message);
    return this.enqueue(async () => {
      const vault = await this.readEncrypted();
      vault[provider] = this.encryption.encryptString(value.trim()).toString('base64');
      await this.writeEncrypted(vault);
      return { ok: true };
    });
  }

  delete(provider) {
    this.validateProvider(provider);
    return this.enqueue(async () => {
      const vault = await this.readEncrypted();
      delete vault[provider];
      await this.writeEncrypted(vault);
      return { ok: true };
    });
  }

  enqueue(operation) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
