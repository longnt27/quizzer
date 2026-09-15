import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CREDENTIAL_PROVIDERS = Object.freeze(['gemini', 'anthropic', 'openai', 'openrouter', 'deepseek', 'openai-compatible', 'mistral-ocr']);
const CREDENTIAL_PROVIDER_SET = new Set(CREDENTIAL_PROVIDERS);

const validateProvider = provider => {
  if (!CREDENTIAL_PROVIDER_SET.has(provider)) throw new Error('Unsupported credential provider');
  return provider;
};

const validateCredential = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw new Error('Credential value is invalid');
  return value.trim();
};

const emptyPayload = () => ({ version: 1, providers: {} });

export class CredentialVault {
  constructor({ filePath, encrypt, decrypt }) {
    if (!filePath) throw new Error('Credential vault file path is required');
    if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new Error('Credential vault encryption is unavailable');
    this.filePath = filePath;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
  }

  async read() {
    try {
      const ciphertext = await readFile(this.filePath);
      const decoded = JSON.parse(this.decrypt(ciphertext));
      if (!decoded || decoded.version !== 1 || !decoded.providers || typeof decoded.providers !== 'object') {
        throw new Error('Credential vault is invalid');
      }
      return decoded;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyPayload();
      throw error;
    }
  }

  async write(payload) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const ciphertext = this.encrypt(JSON.stringify(payload));
    await writeFile(temporaryPath, ciphertext, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  async set(provider, credential) {
    validateProvider(provider);
    const value = validateCredential(credential);
    const payload = await this.read();
    payload.providers[provider] = value;
    await this.write(payload);
  }

  async delete(provider) {
    validateProvider(provider);
    const payload = await this.read();
    delete payload.providers[provider];
    await this.write(payload);
  }

  async get(provider) {
    validateProvider(provider);
    const payload = await this.read();
    const value = payload.providers[provider];
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  async listConfiguredProviders() {
    const payload = await this.read();
    return CREDENTIAL_PROVIDERS.filter(provider => typeof payload.providers[provider] === 'string' && payload.providers[provider].trim());
  }

  async snapshot() {
    const payload = await this.read();
    return Object.fromEntries(CREDENTIAL_PROVIDERS.map(provider => [provider, payload.providers[provider]]));
  }
}
