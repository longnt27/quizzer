import assert from 'node:assert/strict';
import test from 'node:test';
import { ONBOARDING_STEPS, ONBOARDING_VERSION, normalizeOnboardingState, validateOnboardingState } from '../server/onboarding.mjs';

const state = changes => ({
  onboardingVersion: ONBOARDING_VERSION,
  completedSteps: ['welcome', 'hardware', 'provider'],
  currentStep: 'document',
  skipped: false,
  ...changes,
});

test('accepts resumable onboarding evidence for the exact tutorial artifacts', () => {
  const value = state({
    completedSteps: ONBOARDING_STEPS.slice(0, 6),
    currentStep: 'practice',
    documentId: 'document-1',
    generationJobId: 'job-1',
    generationTestId: 'test-1',
  });
  assert.equal(validateOnboardingState(value), value);
  assert.doesNotThrow(() => validateOnboardingState(state({
    completedSteps: [...ONBOARDING_STEPS], currentStep: 'complete', skipped: true, completedAt: 10,
  })));
});

test('rejects malformed, incoherent, or unsupported onboarding state', () => {
  assert.throws(() => validateOnboardingState(), /must be an object/);
  assert.throws(() => validateOnboardingState(state({ extra: true })), /Unknown onboarding field/);
  assert.throws(() => validateOnboardingState(state({ onboardingVersion: 2 })), /Unsupported onboarding version/);
  assert.throws(() => validateOnboardingState(state({ completedSteps: ['welcome', 'welcome'] })), /steps are invalid/);
  assert.throws(() => validateOnboardingState(state({ completedSteps: ['missing'] })), /steps are invalid/);
  assert.throws(() => validateOnboardingState(state({ currentStep: 'missing' })), /Current onboarding step/);
  assert.throws(() => validateOnboardingState(state({ skipped: 'yes' })), /must be true or false/);
  assert.throws(() => validateOnboardingState(state({ completedAt: 0 })), /completion time/);
  assert.throws(() => validateOnboardingState(state({ completedAt: 10 })), /complete step/);
  assert.throws(() => validateOnboardingState(state({ skipped: true })), /must be completed/);
  assert.throws(() => validateOnboardingState(state({ documentId: '' })), /document id/);
  assert.throws(() => validateOnboardingState(state({ generationJobId: 'job-1' })), /recorded together/);
  assert.throws(() => validateOnboardingState(state({ generationTestId: 'test-1' })), /recorded together/);
});

test('moves profiles paused on the removed goal step directly to generation', () => {
  const legacy = state({
    completedSteps: ['welcome', 'hardware', 'provider', 'document', 'instruction'],
    currentStep: 'instruction',
  });
  assert.deepEqual(normalizeOnboardingState(legacy), {
    ...legacy,
    completedSteps: ['welcome', 'hardware', 'provider', 'document'],
    currentStep: 'generate',
  });
  assert.equal(validateOnboardingState(legacy).currentStep, 'generate');
});
