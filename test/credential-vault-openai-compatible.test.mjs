import assert from 'node:assert/strict';
import test from 'node:test';
import { CREDENTIAL_PROVIDERS } from '../desktop/credential-vault.mjs';

test('allows OpenAI-compatible API keys to use the OS-protected credential vault', () => {
  assert.ok(CREDENTIAL_PROVIDERS.includes('openai-compatible'));
});
