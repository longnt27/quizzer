export const ONBOARDING_VERSION = 1;

export const ONBOARDING_STEPS = Object.freeze([
  'welcome',
  'hardware',
  'provider',
  'document',
  'instruction',
  'generate',
  'practice',
  'complete',
]);

const steps = new Set(ONBOARDING_STEPS);
const allowedFields = new Set([
  'onboardingVersion',
  'completedSteps',
  'currentStep',
  'skipped',
  'completedAt',
  'documentId',
  'generationJobId',
  'generationTestId',
]);

const optionalId = (value, label) => {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`${label} is invalid`);
};

export const validateOnboardingState = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Onboarding state must be an object');
  const unknown = Object.keys(input).filter(key => !allowedFields.has(key));
  if (unknown.length) throw new Error(`Unknown onboarding field: ${unknown.join(', ')}`);
  if (input.onboardingVersion !== ONBOARDING_VERSION) throw new Error(`Unsupported onboarding version: ${input.onboardingVersion}`);
  if (!Array.isArray(input.completedSteps) || input.completedSteps.length > ONBOARDING_STEPS.length
    || input.completedSteps.some(step => !steps.has(step)) || new Set(input.completedSteps).size !== input.completedSteps.length) {
    throw new Error('Completed onboarding steps are invalid');
  }
  if (!steps.has(input.currentStep)) throw new Error('Current onboarding step is invalid');
  if (typeof input.skipped !== 'boolean') throw new Error('Onboarding skipped state must be true or false');
  if (input.completedAt !== undefined && (!Number.isSafeInteger(input.completedAt) || input.completedAt <= 0)) {
    throw new Error('Onboarding completion time is invalid');
  }
  if (input.completedAt !== undefined && input.currentStep !== 'complete') {
    throw new Error('Completed onboarding must remain on the complete step');
  }
  if (input.skipped && (input.currentStep !== 'complete' || input.completedAt === undefined)) {
    throw new Error('Skipped onboarding must be completed');
  }
  optionalId(input.documentId, 'Onboarding document id');
  optionalId(input.generationJobId, 'Onboarding generation job id');
  optionalId(input.generationTestId, 'Onboarding generation test id');
  if ((input.generationJobId === undefined) !== (input.generationTestId === undefined)) {
    throw new Error('Onboarding generation job and test ids must be recorded together');
  }
  return input;
};
