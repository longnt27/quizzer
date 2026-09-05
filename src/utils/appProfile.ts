import { db, type StoredAppProfile } from '../db/db';
import type { HardwareProfileId, InterfaceMode, OnboardingStep } from '../types';

export const CURRENT_ONBOARDING_VERSION = 1;
export const CURRENT_WHATS_NEW_VERSION = 1;
export const ONBOARDING_STEPS: OnboardingStep[] = [
  'welcome',
  'hardware',
  'provider',
  'document',
  'instruction',
  'generate',
  'practice',
  'complete',
];

export const createDefaultProfile = (hasExistingLibrary: boolean, now = Date.now()): StoredAppProfile => ({
  id: 'default',
  createdAt: now,
  updatedAt: now,
  interfaceMode: 'simple',
  hardwareProfile: 'lite',
  upgradedExistingLibrary: hasExistingLibrary,
  onboarding: hasExistingLibrary
    ? {
        onboardingVersion: CURRENT_ONBOARDING_VERSION,
        completedSteps: [...ONBOARDING_STEPS],
        currentStep: 'complete',
        skipped: true,
        completedAt: now,
      }
    : {
        onboardingVersion: CURRENT_ONBOARDING_VERSION,
        completedSteps: [],
        currentStep: 'welcome',
        skipped: false,
      },
});

export const ensureAppProfile = async () => {
  const existing = await db.profiles.get('default');
  if (existing) return existing;
  const hasExistingLibrary = (await db.tests.count()) > 0 || (await db.documents.count()) > 0;
  const profile = createDefaultProfile(hasExistingLibrary);
  await db.profiles.add(profile).catch(async error => {
    if ((error as { name?: string }).name !== 'ConstraintError') throw error;
  });
  return (await db.profiles.get('default')) ?? profile;
};

export const updateAppProfile = async (changes: Partial<Omit<StoredAppProfile, 'id' | 'createdAt'>>) => {
  await ensureAppProfile();
  await db.profiles.update('default', { ...changes, updatedAt: Date.now() });
};

export const setInterfaceMode = (interfaceMode: InterfaceMode) => updateAppProfile({ interfaceMode });

export const setHardwareProfile = (hardwareProfile: HardwareProfileId) => updateAppProfile({ hardwareProfile });

export const advanceOnboarding = async (step: OnboardingStep, next: OnboardingStep) => {
  const profile = await ensureAppProfile();
  const completedSteps = profile.onboarding.completedSteps.includes(step)
    ? profile.onboarding.completedSteps
    : [...profile.onboarding.completedSteps, step];
  await updateAppProfile({
    onboarding: {
      ...profile.onboarding,
      onboardingVersion: CURRENT_ONBOARDING_VERSION,
      completedSteps,
      currentStep: next,
      skipped: false,
      ...(next === 'complete' ? { completedAt: Date.now() } : {}),
    },
  });
};

export const goToOnboardingStep = async (currentStep: OnboardingStep) => {
  const profile = await ensureAppProfile();
  await updateAppProfile({ onboarding: { ...profile.onboarding, currentStep } });
};

export const skipOnboarding = async () => {
  const profile = await ensureAppProfile();
  await updateAppProfile({
    onboarding: {
      ...profile.onboarding,
      onboardingVersion: CURRENT_ONBOARDING_VERSION,
      currentStep: 'complete',
      skipped: true,
      completedAt: Date.now(),
    },
  });
};

export const restartOnboarding = async () => updateAppProfile({
  onboarding: {
    onboardingVersion: CURRENT_ONBOARDING_VERSION,
    completedSteps: [],
    currentStep: 'welcome',
    skipped: false,
  },
});
