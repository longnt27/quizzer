import assert from 'node:assert/strict';
import test from 'node:test';
import { databasePathFor, defaultAppDataDirectory, denseIndexPathFor, sparseIndexPathFor } from '../server/paths.mjs';

test('uses native per-user application data paths on every platform', () => {
  assert.equal(defaultAppDataDirectory({ platform: 'darwin', environment: {}, home: '/Users/test' }), '/Users/test/Library/Application Support/Quizzer');
  assert.equal(defaultAppDataDirectory({ platform: 'win32', environment: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, home: 'C:\\Users\\test' }), 'C:\\Users\\test\\AppData\\Roaming/Quizzer');
  assert.equal(defaultAppDataDirectory({ platform: 'linux', environment: { XDG_DATA_HOME: '/data' }, home: '/home/test' }), '/data/quizzer');
  assert.equal(defaultAppDataDirectory({ environment: { QUIZZER_APP_DATA_DIR: '/custom' } }), '/custom');
  assert.equal(databasePathFor('/custom'), '/custom/data/quizzer.sqlite');
  assert.equal(sparseIndexPathFor('/custom'), '/custom/indexes/sparse.sqlite');
  assert.equal(denseIndexPathFor('/custom'), '/custom/indexes/dense.lance');
});
