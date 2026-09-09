import { db, type StoredAppProfile } from '../db/db';
import type { HardwareProfileId, InterfaceMode, OnboardingState, OnboardingStep } from '../types';
import { serviceJson } from './serviceApi';

export const CURRENT_ONBOARDING_VERSION = 1;
export const CURRENT_WHATS_NEW_VERSION = 1;
export const ONBOARDING_STEPS: OnboardingStep[] = [
  'welcome',
  'hardware',
  'provider',
  'document',
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

export const normalizeLegacyAppProfile = (profile: StoredAppProfile): StoredAppProfile => {
  const legacyCurrentStep = (profile.onboarding as unknown as { currentStep: string }).currentStep;
  const legacyCompletedSteps = (profile.onboarding as unknown as { completedSteps: string[] }).completedSteps;
  const currentStep = legacyCurrentStep === 'instruction'
    ? 'generate'
    : ONBOARDING_STEPS.includes(legacyCurrentStep as OnboardingStep)
      ? legacyCurrentStep as OnboardingStep
      : 'welcome';
  const completedSteps = legacyCompletedSteps.filter((step): step is OnboardingStep =>
    ONBOARDING_STEPS.includes(step as OnboardingStep));
  if (currentStep === legacyCurrentStep && completedSteps.length === legacyCompletedSteps.length) return profile;
  const onboarding: OnboardingState = { ...profile.onboarding, currentStep, completedSteps };
  return { ...profile, updatedAt: Date.now(), onboarding };
};

export const ensureAppProfile = async () => {
  const existing = await db.profiles.get('default');
  if (existing) {
    const normalized = normalizeLegacyAppProfile(existing);
    if (normalized !== existing) await db.profiles.put(normalized);
    return normalized;
  }
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

const persistProfileSetting = async (key: 'interface.mode' | 'hardware.profile', value: InterfaceMode | HardwareProfileId) => {
  try {
    await serviceJson('/api/v1/settings', 'PATCH', { values: { [key]: value } });
    window.dispatchEvent(new Event('quizzer:settings-changed'));
  } catch { /* The local profile remains usable while the service reconnects. */ }
};

export const setInterfaceMode = async (interfaceMode: InterfaceMode) => {
  await updateAppProfile({ interfaceMode });
  await persistProfileSetting('interface.mode', interfaceMode);
};

export const setHardwareProfile = async (hardwareProfile: HardwareProfileId) => {
  await updateAppProfile({ hardwareProfile });
  await persistProfileSetting('hardware.profile', hardwareProfile);
};

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
      ...(step === 'complete' ? { completedAt: Date.now() } : {}),
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



export const recordOnboardingDocument = async (documentId: string) => {
  const profile = await ensureAppProfile();
  if (profile.onboarding.currentStep !== 'document' || profile.onboarding.completedAt || profile.onboarding.skipped) return;
  await updateAppProfile({ onboarding: { ...profile.onboarding, documentId } });
};

export const recordOnboardingGeneration = async (generationJobId: string, generationTestId: string) => {
  const profile = await ensureAppProfile();
  if (profile.onboarding.currentStep !== 'generate' || profile.onboarding.completedAt || profile.onboarding.skipped) return;
  await updateAppProfile({ onboarding: { ...profile.onboarding, generationJobId, generationTestId } });
};
