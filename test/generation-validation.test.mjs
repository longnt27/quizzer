import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateActiveRoute, validateCoveragePlan, validateGenerationOptions, validateGenerationOptionsTransition,
  validateGenerationProgress, validateGenerationRejections, validateGenerationRejectionTransition,
  validateNewGenerationJob, validateProviderAttempts,
  validateProviderAttemptTransition, validateProviderRoute,
} from '../server/generation-validation.mjs';
import { resolveSettings } from '../server/settings.mjs';

const resolvedSettings = resolveSettings({ profile: 'balanced', environment: {} }).values;

const options = () => ({
  provider: 'openai',
  model: 'gpt-5-mini',
  questionCount: 2,
  questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 1, coding: 0 },
  multipleChoiceMode: 'single',
  coverageStrategy: 'balanced',
  customInstruction: 'Focus on operational tradeoffs.',
  ragProfile: { id: 'balanced', retrieval: 'hybrid', contextBudget: 8_192, rerank: true },
  routeChain: [{ provider: 'openai', model: 'gpt-5-mini', privacy: 'remote-api', paid: true, approved: true }],
  resolvedSettings,
});

test('validates complete generation snapshots and provider policy metadata', () => {
  const value = options();
  assert.equal(validateGenerationOptions(value, { requireSnapshots: true }), value);
  assert.equal(validateProviderRoute(value.routeChain[0]), value.routeChain[0]);
  assert.throws(() => validateProviderRoute({
    provider: 'openai', privacy: 'local', paid: false, approved: true,
  }), /privacy and cost policy/);
  assert.throws(() => validateGenerationOptions({ ...value, provider: 'unknown' }), /Unsupported generation provider/);
  assert.throws(() => validateGenerationOptions({
    ...value, questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 },
  }), /sum to questionCount/);
  assert.throws(() => validateGenerationOptions({
    ...value, resolvedSettings: { apiKey: 'must-not-be-snapshotted' },
  }), /cannot contain secrets/);
});

test('bounds prompt, route, instruction, and resolved-setting snapshots', () => {
  const value = options();
  const generation = 'Generate {{count}} grounded questions now.';
  const snapshot = {
    id: 'team-grounded', version: 2, name: 'Team grounded', template: generation,
    templates: {
      generation,
      grading: 'Grade {{question}} against its reference answer.',
      rag: 'Retrieve direct evidence for this learning query.',
    },
  };
  assert.doesNotThrow(() => validateGenerationOptions({ ...value, promptProfileSnapshot: snapshot }));
  assert.throws(() => validateGenerationOptions({
    ...value, promptProfileSnapshot: { ...snapshot, templates: { ...snapshot.templates, generation: 'A different generation template long enough.' } },
  }), /generation templates do not match/);
  assert.throws(() => validateGenerationOptions({ ...value, multipleChoiceMode: 'sometimes' }), /multiple-choice mode/);
  assert.throws(() => validateGenerationOptions({ ...value, coverageStrategy: 'random' }), /coverage strategy/);
  assert.throws(() => validateGenerationOptions({ ...value, customInstruction: '' }), /Custom learning instruction/);
  assert.throws(() => validateGenerationOptions({ ...value, routeChain: [] }), /1-10 routes/);
  assert.throws(() => validateGenerationOptions({
    ...value, routeChain: [{ ...value.routeChain[0], model: 'other' }],
  }), /must match a route/);
  assert.throws(() => validateGenerationOptions({
    ...value, routeChain: [value.routeChain[0], { ...value.routeChain[0] }],
  }), /duplicate provider and model routes/);
  assert.throws(() => validateGenerationOptions({
    ...value, routeChain: [{ ...value.routeChain[0], approved: false }],
  }), /explicitly approved/);

  assert.throws(() => validateGenerationOptions({ ...value, resolvedSettings: { ...resolvedSettings, 'hardware.profile': undefined } }), /JSON-compatible/);
  assert.throws(() => validateGenerationOptions({ ...value, resolvedSettings: { ...resolvedSettings, '': true } }), /invalid field name/);
  assert.throws(() => validateGenerationOptions({ ...value, resolvedSettings: { ...resolvedSettings, 'hardware.profile': Array.from({ length: 1_001 }) } }), /too many values/);
  assert.throws(() => validateGenerationOptions({ ...value, resolvedSettings: { ...resolvedSettings, 'generation.defaultProvider': 'x'.repeat(100_001) } }), /too large/);
  let deeplyNested = {};
  for (let index = 0; index < 10; index += 1) deeplyNested = { nested: deeplyNested };
  assert.throws(() => validateGenerationOptions({ ...value, resolvedSettings: deeplyNested }), /nested too deeply/);

  const withoutRoute = { ...value };
  delete withoutRoute.routeChain;
  assert.throws(() => validateGenerationOptions(withoutRoute, { requireSnapshots: true }), /approved provider route chain/);
  const withoutSettings = { ...value };
  delete withoutSettings.resolvedSettings;
  assert.throws(() => validateGenerationOptions(withoutSettings, { requireSnapshots: true }), /require resolved settings/);
  assert.throws(() => validateGenerationOptions({
    ...value, resolvedSettings: { 'hardware.profile': 'balanced' },
  }, { requireCompleteSettings: true }), /Missing setting/);
  assert.throws(() => validateGenerationOptions({
    ...value, resolvedSettings: { ...resolvedSettings, 'retrieval.contextBudget': 4_096 },
  }, { requireCompleteSettings: true }), /RAG profile must match/);
});

test('keeps generation semantics and route history immutable across failover', () => {
  const value = options();
  const codexRoute = { provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true };
  const continued = {
    ...value,
    provider: 'codex',
    model: undefined,
    routeChain: [...value.routeChain, codexRoute],
  };
  assert.equal(validateGenerationOptionsTransition(value, continued, { allowRouteApproval: true }), continued);
  assert.throws(() => validateGenerationOptionsTransition(value, continued), /workers cannot change the approved route chain/);
  assert.throws(() => validateGenerationOptionsTransition(value, {
    ...continued, customInstruction: 'Replace the original learning goal.',
  }, { allowRouteApproval: true }), /customInstruction cannot change/);
  assert.throws(() => validateGenerationOptionsTransition(value, {
    ...continued, routeChain: [codexRoute, value.routeChain[0]],
  }, { allowRouteApproval: true }), /removed, reordered, or changed/);
  assert.throws(() => validateGenerationOptionsTransition(value, {
    ...continued, routeChain: [...value.routeChain, { ...codexRoute, approved: false }],
  }, { allowRouteApproval: true }), /newly appended provider route must be explicitly approved/);

  const pendingCodex = { ...codexRoute, approved: false };
  const withPendingRoute = { ...value, routeChain: [...value.routeChain, pendingCodex] };
  const approvedCodex = { ...continued, routeChain: [...value.routeChain, codexRoute] };
  assert.equal(validateGenerationOptionsTransition(withPendingRoute, approvedCodex, { allowRouteApproval: true }), approvedCodex);
  assert.throws(() => validateGenerationOptionsTransition(withPendingRoute, {
    ...approvedCodex, provider: 'openai', model: 'gpt-5-mini',
  }, { allowRouteApproval: true }), /selected for continuation/);
});

test('accepts only pristine queued jobs at the creation boundary', () => {
  const job = {
    id: 'job-validation-one', testId: 'test-validation-one', name: 'Validated job',
    createdAt: 10, updatedAt: 10, status: 'queued', documentIds: ['doc-one'], options: options(),
    questions: [], rejected: 0, rounds: {},
  };
  assert.equal(validateNewGenerationJob(job), job);
  assert.throws(() => validateNewGenerationJob({ ...job, status: 'running' }), /must be queued/);
  assert.throws(() => validateNewGenerationJob({ ...job, workerId: 'forged-worker' }), /unsupported fields: workerId/);
  assert.throws(() => validateNewGenerationJob({ ...job, questions: [{ statement: 'forged' }] }), /start without questions/);
  assert.throws(() => validateNewGenerationJob({ ...job, documentIds: ['doc-one', 'doc-one'] }), /document ids are invalid/);
});

test('validates route-bound attempts, progress, and retrieval coverage', () => {
  const value = options();
  const attempts = [{
    provider: 'openai', model: 'gpt-5-mini', routeIndex: 0, at: 20, accepted: 1,
    outcome: 'failed', errorCode: 'provider_limit', message: 'Quota reached',
  }];
  assert.equal(validateProviderAttempts(attempts, value), attempts);
  assert.throws(() => validateProviderAttempts([{ ...attempts[0], provider: 'gemini' }], value), /does not match/);
  assert.throws(() => validateProviderAttempts({}, value), /array of at most/);
  assert.throws(() => validateProviderAttempts([{ ...attempts[0], outcome: 'unknown' }], value), /outcome is invalid/);
  assert.throws(() => validateProviderAttempts([{ ...attempts[0], accepted: 3 }], value), /accepted count is invalid/);
  const continuedOptions = {
    ...value,
    provider: 'codex',
    model: undefined,
    routeChain: [...value.routeChain, { provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true }],
  };
  const continuedAttempts = [...attempts, {
    provider: 'codex', routeIndex: 1, at: 21, accepted: 1, outcome: 'manually-selected',
  }];
  assert.equal(validateProviderAttemptTransition(continuedAttempts, attempts, continuedOptions, 1), continuedAttempts);
  assert.throws(() => validateProviderAttemptTransition(continuedAttempts.slice(1), attempts, continuedOptions, 1), /attempt history is append-only|cannot be removed or changed/);
  assert.throws(() => validateProviderAttemptTransition([
    { ...attempts[0], message: 'Rewritten failure' }, continuedAttempts[1],
  ], attempts, continuedOptions, 1), /cannot be removed or changed/);
  assert.throws(() => validateProviderAttemptTransition([
    ...attempts, { ...continuedAttempts[1], accepted: 0 },
  ], attempts, continuedOptions, 1), /current accepted-question checkpoint/);
  assert.equal(validateActiveRoute(0, value), 0);
  assert.throws(() => validateActiveRoute(1, value), /does not match/);

  const progress = {
    accepted: 1, target: 2, round: 1, maxRounds: 5, rejected: 0, currentType: 'reasoning',
    typeAccepted: 0, typeTarget: 1, phase: 'requesting', provider: 'openai', parallelRequests: 1,
  };
  assert.equal(validateGenerationProgress(progress, value), progress);
  assert.throws(() => validateGenerationProgress({ ...progress, accepted: 3 }, value), /accepted is invalid|exceeds/);
  assert.throws(() => validateGenerationProgress({ ...progress, currentType: 'essay' }, value), /question type/);
  assert.throws(() => validateGenerationProgress({ ...progress, phase: 'done' }, value), /phase/);
  assert.throws(() => validateGenerationProgress({ ...progress, provider: 'unknown' }, value), /provider/);
  assert.throws(() => validateGenerationProgress({ ...progress, parallelRequests: 0 }, value), /parallel request/);
  assert.throws(() => validateGenerationProgress({ ...progress, accepted: 2, target: 1 }, value), /exceeds its target/);

  const coverage = {
    strategy: 'balanced', createdAt: 30,
    slots: [
      { documentIds: ['doc-one'], chunkIndexes: { 'doc-one': 0 } },
      { documentIds: ['doc-two'], chunkIndexes: { 'doc-two': 2 } },
    ],
  };
  assert.equal(validateCoveragePlan(coverage, ['doc-one', 'doc-two'], 2), coverage);
  assert.throws(() => validateCoveragePlan({ ...coverage, slots: coverage.slots.slice(0, 1) }, ['doc-one'], 2), /match the question count/);
  assert.throws(() => validateCoveragePlan({
    ...coverage, slots: [{ documentIds: ['other'], chunkIndexes: { other: 0 } }, coverage.slots[1]],
  }, ['doc-one', 'doc-two'], 2), /document ids are invalid/);
  assert.throws(() => validateCoveragePlan({
    ...coverage, slots: [{ documentIds: ['doc-one'], chunkIndexes: { 'doc-two': 0 } }, coverage.slots[1]],
  }, ['doc-one', 'doc-two'], 2), /out-of-scope chunk index/);

  const rejections = [{
    at: 40, type: 'reasoning', round: 1, reason: 'ungrounded', count: 1,
    statement: 'Why is an unrelated claim true?',
  }];
  assert.equal(validateGenerationRejections(rejections), rejections);
  const appended = [...rejections, { at: 41, type: 'reasoning', round: 2, reason: 'duplicate', count: 2 }];
  assert.equal(validateGenerationRejectionTransition(appended, rejections), appended);
  assert.throws(() => validateGenerationRejectionTransition(appended.slice(1), rejections), /append-only/);
  assert.throws(() => validateGenerationRejections([{ ...rejections[0], reason: 'unknown' }]), /reason is invalid/);
  assert.throws(() => validateGenerationRejections([{ ...rejections[0], statement: 'x'.repeat(501) }]), /statement is invalid/);
});
