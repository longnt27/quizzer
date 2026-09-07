import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableCoverageFailure } from '../scripts/coverage-retry.mjs';

const incompleteReport = `
1..366
# tests 366
# pass 366
# fail 0
# Warning: Could not report code coverage. SyntaxError: Unexpected end of JSON input
`;

test('retries one incomplete experimental coverage report after every test passes', () => {
  assert.equal(isRetryableCoverageFailure({ attempt: 1, signal: null, output: incompleteReport }), true);
});

test('never retries test failures, signals, unrelated errors, or a second incomplete report', () => {
  assert.equal(isRetryableCoverageFailure({ attempt: 1, signal: null, output: incompleteReport.replace('# fail 0', '# fail 1') }), false);
  assert.equal(isRetryableCoverageFailure({ attempt: 1, signal: 'SIGTERM', output: incompleteReport }), false);
  assert.equal(isRetryableCoverageFailure({ attempt: 1, signal: null, output: '# fail 0\nError: assertion failed' }), false);
  assert.equal(isRetryableCoverageFailure({ attempt: 2, signal: null, output: incompleteReport }), false);
});
