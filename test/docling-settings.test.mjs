import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSettings, SETTINGS_SCHEMA, validateSettings } from '../server/settings.mjs';

test('accepts Docling as an explicit extractor provider and normalizes it to the managed component', () => {
  assert.deepEqual(validateSettings({ 'extraction.provider': 'docling' }), {
    'extraction.provider': 'docling',
  });
  const resolved = resolveSettings({
    profile: 'max',
    environment: {},
    user: { 'extraction.provider': 'docling' },
  });
  assert.equal(resolved.values['extraction.provider'], 'docling');
  assert.equal(resolved.values['extraction.extractorPlugin'], 'docling');
  assert.equal(resolved.values['extraction.marker'], false);
  assert.equal(resolved.sources['extraction.extractorPlugin'], 'user');
  assert.equal(resolved.sources['extraction.marker'], 'user');
  assert.ok(SETTINGS_SCHEMA.properties['extraction.provider'].enum.includes('docling'));
});
