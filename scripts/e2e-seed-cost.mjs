/*
 * Cost-continuation browser fixtures are deliberately created before the
 * service starts.  Keeping this in an e2e-only script means production never
 * exposes a fixture endpoint or an environment-controlled mutation path.
 */
if (process.env.QUIZZER_E2E_SEED_COST !== '1') {
  throw new Error('Cost E2E fixtures require QUIZZER_E2E_SEED_COST=1');
}
if (!process.env.QUIZZER_APP_DATA_DIR || !process.env.QUIZZER_DATABASE_PATH) {
  throw new Error('Cost E2E fixtures require an isolated Quizzer data directory');
}

const { resolveSettings } = await import('../server/settings.mjs');
const {
  claimGenerationJob, closeDatabase, createGenerationJobs,
  finalizeGenerationAttempt, putRecord, reserveGenerationAttempt,
} = await import('../server/storage.mjs');

const timestamp = Date.now();
const workerId = 'e2e-cost-fixture-worker';
const settings = resolveSettings({ environment: {} }).values;
const document = {
  id: 'e2e-cost-document', name: 'Cost continuation guide.md', createdAt: timestamp,
  mimeType: 'text/markdown', size: 240, tags: ['e2e', 'cost'],
  content: '# Durable cost continuation\n\nQuizzer preserves accepted questions before asking for explicit cost approval. A retry only generates the unfinished slots.\n',
  contentHash: 'e'.repeat(64), parserVersion: 'e2e-fixture', extractionSchemaVersion: 1,
  extractedAt: timestamp, extractionContentHash: 'e'.repeat(64), indexedAt: timestamp,
  indexVersion: 3, documentVersionHash: 'e'.repeat(64),
  chunks: [{ id: 'e2e-cost-document:span:0:fixture', index: 0, start: 0, end: 145, textHash: 'e'.repeat(64) }],
};
putRecord('documents', document.id, document);

const profile = {
  id: 'default', createdAt: timestamp, updatedAt: timestamp, interfaceMode: 'advanced',
  hardwareProfile: 'balanced', upgradedExistingLibrary: false,
  onboarding: { onboardingVersion: 1, completedSteps: [], currentStep: 'welcome', skipped: false },
};
putRecord('profiles', profile.id, profile);

const pricedRoute = {
  provider: 'codex', model: 'priced-fixture-model', privacy: 'signed-in-agent', paid: false, approved: true,
  pricing: { inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 2_000_000 },
  usage: 'provider-reported',
};
const unpricedRoute = {
  provider: 'codex', model: 'recovery-fixture-model', privacy: 'signed-in-agent', paid: false, approved: true,
};
const promptProfileSnapshot = {
  id: 'e2e-cost-profile', version: 1, name: 'Cost E2E profile',
  template: 'Create {{count}} {{questionType}} questions from the supplied source and explain each answer clearly.',
};
const optionsFor = (route, costCeilingMicroUsd) => ({
  provider: route.provider, model: route.model, questionCount: 2,
  questionCounts: { multipleChoice: 2, fillBlank: 0, reasoning: 0, coding: 0 },
  multipleChoiceMode: 'single', coverageStrategy: 'balanced',
  customInstruction: 'Focus on durable cost continuation only.', promptProfileSnapshot,
  ragProfile: { id: settings['hardware.profile'], retrieval: settings['retrieval.mode'], contextBudget: settings['retrieval.contextBudget'], rerank: settings['retrieval.rerank'] },
  routeChain: [route], resolvedSettings: settings,
  ...(costCeilingMicroUsd === undefined ? {} : { costCeilingMicroUsd }),
});

const savedQuestion = index => ({
  type: 'multiple-choice', statement: `Saved cost checkpoint question ${index}`,
  answer: [
    { correct: true, content: 'Retain accepted questions', explanation: 'Checkpointed answers are never discarded.' },
    { correct: false, content: 'Discard the checkpoint', explanation: 'That would lose durable progress.' },
    { correct: false, content: 'Charge twice automatically', explanation: 'Recovery requires explicit consent.' },
  ],
});
const progress = { accepted: 1, target: 2, round: 1, maxRounds: 3, rejected: 0, currentType: 'multiple-choice', typeAccepted: 1, typeTarget: 2, phase: 'validating', provider: 'codex' };
const createQueuedJob = (id, name, options) => {
  const job = {
    id, testId: `${id}-test`, name, status: 'queued', createdAt: timestamp, updatedAt: timestamp,
    documentIds: [document.id], options, questions: [], rejected: 0, rounds: {},
  };
  createGenerationJobs([job]);
  const leased = claimGenerationJob({ workerId, leaseMs: 45_000, now: timestamp, providerConcurrency: {} });
  if (!leased || leased.id !== id) throw new Error(`Could not lease fixture job ${id}`);
  return leased;
};
const pauseJob = (leased, errorCode, extra = {}) => {
  const paused = {
    ...leased.data, status: 'paused', errorCode, error: extra.error ?? 'Fixture job requires explicit continuation.',
    questions: [savedQuestion(1)], progress, workerId: undefined, leaseId: undefined, leaseExpiresAt: undefined,
    updatedAt: timestamp, ...extra,
  };
  return putRecord('generationJobs', leased.id, paused).data;
};

const ceilingLeased = createQueuedJob(
  'e2e-cost-ceiling', 'Cost ceiling continuation', optionsFor(pricedRoute, 1_000_000),
);
// Create a genuine finalized accounting checkpoint: 100k input + 200k output
// at the fixture route price equals $0.50 of committed spend.
const ceilingAttempt = `attempt-${'a'.repeat(48)}`;
const reserved = reserveGenerationAttempt(ceilingLeased.id, {
  workerId, leaseId: ceilingLeased.data.leaseId, attemptId: ceilingAttempt, routeIndex: 0,
  maxInputTokens: 100_000, maxOutputTokens: 200_000, now: timestamp + 2,
});
const finalized = finalizeGenerationAttempt(ceilingLeased.id, {
  workerId, leaseId: reserved.data.leaseId, attemptId: ceilingAttempt,
  usage: { inputTokens: 100_000, outputTokens: 200_000, totalTokens: 300_000 }, now: timestamp + 3,
});
pauseJob(finalized, 'cost_ceiling', {
  error: 'Generation cost ceiling reached; unfinished questions were preserved.',
});

const recoveryLeased = createQueuedJob('e2e-cost-recovery', 'Cost recovery continuation', optionsFor(unpricedRoute));
// The second fixture is intentionally left with a real open, unknown-cost
// reservation so the service can validate and append recovery approval.
const recoveryAttempt = `attempt-${'b'.repeat(48)}`;
const recoveryReserved = reserveGenerationAttempt(recoveryLeased.id, {
  workerId, leaseId: recoveryLeased.data.leaseId, attemptId: recoveryAttempt, routeIndex: 0,
  maxInputTokens: 10_000, maxOutputTokens: 10_000, now: timestamp + 5,
});
pauseJob(recoveryReserved, 'cost_recovery', {
  recoveryAttemptId: recoveryAttempt,
  error: 'A prior generation request may have been charged, but its output was not checkpointed.',
});

const historyLeased = createQueuedJob('e2e-cost-history', 'Historical over-ceiling warning', optionsFor(pricedRoute, 300_000));
const historyAttempt = `attempt-${'c'.repeat(48)}`;
const historyReserved = reserveGenerationAttempt(historyLeased.id, {
  workerId, leaseId: historyLeased.data.leaseId, attemptId: historyAttempt, routeIndex: 0,
  maxInputTokens: 25_000, maxOutputTokens: 25_000, now: timestamp + 7,
});
const historyFinalized = finalizeGenerationAttempt(historyLeased.id, {
  workerId, leaseId: historyReserved.data.leaseId, attemptId: historyAttempt,
  usage: { inputTokens: 100_000, outputTokens: 200_000, totalTokens: 300_000 }, now: timestamp + 8,
});
pauseJob(historyFinalized, undefined, {
  error: 'Provider usage exceeded the historical ceiling; review before continuing.',
});

// Keep the seed script safe for a subsequent import in the same process.
closeDatabase();
