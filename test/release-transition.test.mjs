import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseTransition } from '../scripts/validate-release-transition.mjs';

const documents = (version, previousVersion = '1.0.0-beta.5') => ({
  packageDocument: { name: 'quizzer', version },
  lockDocument: { name: 'quizzer', version, packages: { '': { name: 'quizzer', version } } },
  previousPackageDocument: { name: 'quizzer', version: previousVersion },
});

test('validates beta and stable release transitions with matching lock metadata', () => {
  assert.deepEqual(validateReleaseTransition(documents('1.0.0-beta.6')), {
    version: '1.0.0-beta.6', previousVersion: '1.0.0-beta.5', tag: 'v1.0.0-beta.6', channel: 'beta',
  });
  assert.deepEqual(validateReleaseTransition(documents('1.0.0', '1.0.0-beta.6')), {
    version: '1.0.0', previousVersion: '1.0.0-beta.6', tag: 'v1.0.0', channel: 'stable',
  });
});

test('rejects stale, decreasing, and malformed versions', () => {
  assert.throws(() => validateReleaseTransition(documents('1.0.0-beta.5')), /must be greater/);
  assert.throws(() => validateReleaseTransition(documents('1.0.0-beta.4')), /must be greater/);
  assert.throws(() => validateReleaseTransition(documents('v1.0.0-beta.6')), /canonical semantic version/);
  assert.throws(() => validateReleaseTransition(documents('1.0.0-beta.06')), /canonical semantic version/);
});

test('rejects either package-lock version when it differs from the package version', () => {
  const topLevelMismatch = documents('1.0.0-beta.6');
  topLevelMismatch.lockDocument.version = '1.0.0-beta.5';
  assert.throws(() => validateReleaseTransition(topLevelMismatch), /must match package.json/);

  const rootMismatch = documents('1.0.0-beta.6');
  rootMismatch.lockDocument.packages[''].version = '1.0.0-beta.5';
  assert.throws(() => validateReleaseTransition(rootMismatch), /must match package.json/);
});
