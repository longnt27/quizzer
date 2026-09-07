const TRANSIENT_COVERAGE_REPORT_FAILURE = /Could not report code coverage\.[^\n]*Unexpected end of JSON input/;
const SUCCESSFUL_TEST_SUMMARY = /# fail 0(?:\r?\n|$)/;
export const MAX_COVERAGE_ATTEMPTS = 3;

export const isRetryableCoverageFailure = ({ attempt, signal, output, maxAttempts = MAX_COVERAGE_ATTEMPTS }) => (
  attempt < maxAttempts
  && !signal
  && TRANSIENT_COVERAGE_REPORT_FAILURE.test(output)
  && SUCCESSFUL_TEST_SUMMARY.test(output)
);
