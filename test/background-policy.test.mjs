import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedBackgroundFallback, summarizeBackgroundState } from '../desktop/background-policy.mjs';

test('keeps background work enabled by default and counts unfinished jobs', () => {
  const state = summarizeBackgroundState({
    settings: {},
    generationJobs: [{ status: 'queued' }, { status: 'running' }, { status: 'completed' }, { status: 'paused' }],
    indexJobs: [{ status: 'running' }, { status: 'failed' }, { status: 'cancelled' }],
  });
  assert.equal(state.continueInBackground, true);
  assert.equal(state.activeGenerationJobs, 3);
  assert.equal(state.activeIndexJobs, 2);
  assert.equal(state.activeJobCount, 5);
  assert.equal(state.runningJobs, 2);
});

test('honors the explicit quit preference without treating completed work as active', () => {
  assert.deepEqual(summarizeBackgroundState({
    settings: { 'jobs.continueInBackground': false },
    generationJobs: [{ status: 'completed' }, { status: 'cancelled' }],
    indexJobs: [{ status: 'completed' }],
  }), {
    continueInBackground: false,
    activeGenerationJobs: 0,
    activeIndexJobs: 0,
    activeJobCount: 0,
    runningJobs: 0,
  });
  assert.equal(protectedBackgroundFallback.continueInBackground, true);
  assert.equal(protectedBackgroundFallback.serviceUnavailable, true);
});

test('rejects malformed settings and job collections', () => {
  assert.throws(() => summarizeBackgroundState({ settings: [] }), /settings must be an object/);
  assert.throws(() => summarizeBackgroundState({ generationJobs: {} }), /jobs must be arrays/);
});

