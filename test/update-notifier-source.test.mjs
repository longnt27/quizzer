import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('desktop notifier checks proactively and exposes expandable release notes', async () => {
  const source = await readFile(new URL('../src/components/UpdateAvailableNotifier.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sessionStorage/);
  assert.match(source, /window\.addEventListener\('focus', refresh\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(source, /window\.setInterval\(refresh, UPDATE_CHECK_INTERVAL_MS\)/);
  assert.match(source, /<details className="update-release-notes">/);
  assert.match(source, /What's new in this update/);
});
