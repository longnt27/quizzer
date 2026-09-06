import { PROVIDER_POLICIES } from './provider-policy.mjs';
import { validateOllamaModelName } from './ollama-generation.mjs';
import { validateSettings } from './settings.mjs';
import { isDeepStrictEqual } from 'node:util';

const generationProviders = new Set(Object.keys(PROVIDER_POLICIES));
const questionTypes = new Set(['multiple-choice', 'fill-blank', 'reasoning', 'coding']);
const coverageStrategies = new Set(['balanced', 'proportional', 'ai-selected', 'cross-document']);
const rejectionReasons = new Set([
  'invalid-schema', 'ungrounded', 'instruction-mismatch', 'duplicate', 'empty-response', 'out-of-coverage',
]);
const secretName = /(api.?key|password|secret|token|credential)/i;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, minimum = 1, maximum = 2_000) => typeof value === 'string'
  && value.trim().length >= minimum && value.length <= maximum;
const requireObject = (value, message) => {
  if (!isObject(value)) throw new Error(message);
  return value;
};
const rejectUnknown = (value, allowed, label) => {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
};
const boundedInteger = (value, minimum, maximum, message) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(message);
};

const validateJsonValue = (value, path, depth = 0) => {
  if (depth > 8) throw new Error(`${path} is nested too deeply`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error(`${path} contains too many values`);
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) throw new Error(`${path} must contain JSON-compatible values`);
  if (Object.keys(value).length > 500) throw new Error(`${path} contains too many fields`);
  for (const [key, item] of Object.entries(value)) {
    if (!boundedText(key, 1, 200)) throw new Error(`${path} contains an invalid field name`);
    if (secretName.test(key)) throw new Error(`${path} cannot contain secrets`);
    validateJsonValue(item, `${path}.${key}`, depth + 1);
  }
};

const validatePromptSnapshot = input => {
  const snapshot = requireObject(input, 'Prompt profile snapshot must be an object');
  rejectUnknown(snapshot, new Set(['id', 'version', 'name', 'template', 'templates']), 'Prompt profile snapshot');
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(snapshot.id ?? '')) throw new Error('Prompt profile snapshot id is invalid');
  boundedInteger(snapshot.version, 1, 1_000_000, 'Prompt profile snapshot version must be a positive integer');
  if (!boundedText(snapshot.name, 1, 100)) throw new Error('Prompt profile snapshot name is invalid');
  if (!boundedText(snapshot.template, 20, 20_000)) throw new Error('Prompt profile generation template is invalid');
  if (snapshot.templates !== undefined) {
    const templates = requireObject(snapshot.templates, 'Prompt profile templates must be an object');
    rejectUnknown(templates, new Set(['generation', 'grading', 'rag']), 'Prompt profile templates');
    for (const kind of ['generation', 'grading', 'rag']) {
      if (!boundedText(templates[kind], 20, 20_000)) throw new Error(`Prompt profile ${kind} template is invalid`);
    }
    if (templates.generation !== snapshot.template) throw new Error('Prompt profile generation templates do not match');
  }
};

const expectedRouteMetadata = provider => {
  const policy = PROVIDER_POLICIES[provider];
  return {
    privacy: policy.privacy,
    paid: policy.billing === 'usage-based',
  };
};

export const validateProviderRoute = input => {
  const route = requireObject(input, 'Provider route must be an object');
  rejectUnknown(route, new Set(['provider', 'model', 'privacy', 'paid', 'approved']), 'Provider route');
  if (!generationProviders.has(route.provider)) throw new Error(`Unsupported generation provider: ${route.provider}`);
  if (route.model !== undefined && !boundedText(route.model, 1, 200)) throw new Error('Provider route model is invalid');
  if (route.provider === 'plugin' && !pluginIdPattern.test(route.model ?? '')) {
    throw new Error('Plugin provider routes require an installed generator plugin id as their model');
  }
  if (route.provider === 'ollama') validateOllamaModelName(route.model);
  if (typeof route.paid !== 'boolean' || typeof route.approved !== 'boolean') throw new Error('Provider route approval and cost flags must be boolean');
  const expected = expectedRouteMetadata(route.provider);
  if (route.privacy !== expected.privacy || route.paid !== expected.paid) {
    throw new Error(`Provider route metadata does not match the ${route.provider} privacy and cost policy`);
  }
  return route;
};

const validateRagProfile = input => {
  const profile = requireObject(input, 'RAG profile must be an object');
  rejectUnknown(profile, new Set(['id', 'retrieval', 'contextBudget', 'rerank']), 'RAG profile');
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(profile.id ?? '')) throw new Error('RAG profile id is invalid');
  if (!['sparse', 'hybrid'].includes(profile.retrieval)) throw new Error('RAG retrieval mode is invalid');
  boundedInteger(profile.contextBudget, 256, 65_536, 'RAG context budget must be an integer from 256 to 65536');
  if (typeof profile.rerank !== 'boolean') throw new Error('RAG reranking flag must be boolean');
};

const routeMatchesOptions = (route, options) => route.provider === options.provider
  && (route.model ?? undefined) === (options.model ?? undefined);
const routeIdentity = route => ({
  provider: route.provider,
  model: route.model,
  privacy: route.privacy,
  paid: route.paid,
});
const immutableGenerationOptionKeys = [
  'questionCount', 'questionCounts', 'multipleChoiceMode', 'coverageStrategy', 'customInstruction',
  'promptProfileSnapshot', 'ragProfile', 'resolvedSettings',
];

export const validateGenerationOptions = (input, { requireSnapshots = false, requireCompleteSettings = false } = {}) => {
  const options = requireObject(input, 'Generation options must be an object');
  rejectUnknown(options, new Set([
    'provider', 'model', 'questionCount', 'questionCounts', 'multipleChoiceMode', 'coverageStrategy',
    'customInstruction', 'promptProfileSnapshot', 'ragProfile', 'routeChain', 'resolvedSettings',
  ]), 'Generation options');
  if (!generationProviders.has(options.provider)) throw new Error(`Unsupported generation provider: ${options.provider}`);
  if (options.model !== undefined && !boundedText(options.model, 1, 200)) throw new Error('Generation model is invalid');
  if (options.provider === 'plugin' && !pluginIdPattern.test(options.model ?? '')) {
    throw new Error('Plugin generation requires an installed generator plugin id as its model');
  }
  if (options.provider === 'ollama') validateOllamaModelName(options.model);
  boundedInteger(options.questionCount, 1, 200, 'Generation question count must be an integer from 1 to 200');
  if (options.questionCounts !== undefined) {
    const counts = requireObject(options.questionCounts, 'Generation question counts must be an object');
    rejectUnknown(counts, new Set(['multipleChoice', 'fillBlank', 'reasoning', 'coding']), 'Generation question counts');
    for (const [type, count] of Object.entries(counts)) {
      boundedInteger(count, 0, 200, `Generation ${type} count must be an integer from 0 to 200`);
    }
    if (Object.keys(counts).length !== 4 || Object.values(counts).reduce((sum, count) => sum + count, 0) !== options.questionCount) {
      throw new Error('Generation question counts must contain every type and sum to questionCount');
    }
  }
  if (options.multipleChoiceMode !== undefined && !['single', 'multiple', 'mixed'].includes(options.multipleChoiceMode)) {
    throw new Error('Generation multiple-choice mode is invalid');
  }
  if (options.coverageStrategy !== undefined && !coverageStrategies.has(options.coverageStrategy)) {
    throw new Error('Generation coverage strategy is invalid');
  }
  if (options.customInstruction !== undefined && !boundedText(options.customInstruction, 1, 2_000)) {
    throw new Error('Custom learning instruction must contain 1-2000 characters');
  }
  if (options.promptProfileSnapshot !== undefined) validatePromptSnapshot(options.promptProfileSnapshot);
  if (options.ragProfile !== undefined) validateRagProfile(options.ragProfile);
  if (options.routeChain !== undefined) {
    if (!Array.isArray(options.routeChain) || !options.routeChain.length || options.routeChain.length > 10) {
      throw new Error('Provider route chain must contain 1-10 routes');
    }
    options.routeChain.forEach(validateProviderRoute);
    const routeKeys = options.routeChain.map(route => `${route.provider}\0${route.model ?? ''}`);
    if (new Set(routeKeys).size !== routeKeys.length) throw new Error('Provider route chain cannot contain duplicate provider and model routes');
    const activeRoute = options.routeChain.find(route => routeMatchesOptions(route, options));
    if (!activeRoute) throw new Error('Generation provider and model must match a route in the route chain');
    if (!activeRoute.approved) throw new Error('The active provider route must be explicitly approved');
  }
  if (options.resolvedSettings !== undefined) {
    requireObject(options.resolvedSettings, 'Resolved generation settings must be an object');
    validateJsonValue(options.resolvedSettings, 'Resolved generation settings');
    if (JSON.stringify(options.resolvedSettings).length > 100_000) throw new Error('Resolved generation settings are too large');
    if (requireCompleteSettings) {
      validateSettings(options.resolvedSettings, { partial: false });
      if (options.ragProfile && (options.resolvedSettings['hardware.profile'] !== options.ragProfile.id
        || options.resolvedSettings['retrieval.mode'] !== options.ragProfile.retrieval
        || options.resolvedSettings['retrieval.contextBudget'] !== options.ragProfile.contextBudget
        || options.resolvedSettings['retrieval.rerank'] !== options.ragProfile.rerank)) {
        throw new Error('RAG profile must match the complete resolved settings snapshot');
      }
    }
  }
  if (requireSnapshots) {
    if (!options.ragProfile) throw new Error('New generation jobs require a RAG profile snapshot');
    if (!options.routeChain) throw new Error('New generation jobs require an approved provider route chain');
    if (!options.resolvedSettings) throw new Error('New generation jobs require resolved settings');
  }
  return options;
};

export const validateGenerationOptionsTransition = (previous, next, { allowRouteApproval = false } = {}) => {
  if (!isModernGenerationOptions(previous)) return next;
  for (const key of immutableGenerationOptionKeys) {
    if (!isDeepStrictEqual(previous[key], next[key])) {
      throw new Error(`Generation option ${key} cannot change after the job is created`);
    }
  }
  const previousRoutes = previous.routeChain ?? [];
  const nextRoutes = next.routeChain ?? [];
  if (!allowRouteApproval) {
    if (!isDeepStrictEqual(previousRoutes, nextRoutes)) {
      throw new Error('Generation workers cannot change the approved route chain');
    }
    return next;
  }
  if (nextRoutes.length < previousRoutes.length || nextRoutes.length > previousRoutes.length + 1) {
    throw new Error('A resume can only retain routes or append one approved route');
  }
  let newlyApprovedIndex = -1;
  for (let index = 0; index < previousRoutes.length; index += 1) {
    const previousRoute = previousRoutes[index];
    const nextRoute = nextRoutes[index];
    if (!isDeepStrictEqual(routeIdentity(previousRoute), routeIdentity(nextRoute))) {
      throw new Error('Existing provider routes cannot be removed, reordered, or changed');
    }
    if (previousRoute.approved && !nextRoute.approved) throw new Error('Provider route approval cannot be revoked from generation history');
    if (!previousRoute.approved && nextRoute.approved) {
      if (newlyApprovedIndex >= 0) throw new Error('A resume can approve only one provider route');
      newlyApprovedIndex = index;
    }
  }
  if (nextRoutes.length > previousRoutes.length) {
    if (newlyApprovedIndex >= 0) throw new Error('A resume can approve only one provider route');
    newlyApprovedIndex = nextRoutes.length - 1;
    if (!nextRoutes[newlyApprovedIndex].approved) throw new Error('A newly appended provider route must be explicitly approved');
  }
  if (newlyApprovedIndex >= 0 && !routeMatchesOptions(nextRoutes[newlyApprovedIndex], next)) {
    throw new Error('A resume can only approve the provider route selected for continuation');
  }
  return next;
};

export const validateProviderAttempts = (input, options) => {
  if (!Array.isArray(input) || input.length > 1_000) throw new Error('Provider attempts must be an array of at most 1000 items');
  const routes = options?.routeChain;
  for (const attempt of input) {
    requireObject(attempt, 'Provider attempt must be an object');
    rejectUnknown(attempt, new Set(['provider', 'model', 'routeIndex', 'at', 'accepted', 'outcome', 'errorCode', 'message']), 'Provider attempt');
    if (!generationProviders.has(attempt.provider)) throw new Error(`Unsupported generation provider: ${attempt.provider}`);
    if (attempt.model !== undefined && !boundedText(attempt.model, 1, 200)) throw new Error('Provider attempt model is invalid');
    boundedInteger(attempt.routeIndex, 0, 999, 'Provider attempt route index is invalid');
    boundedInteger(attempt.at, 0, Number.MAX_SAFE_INTEGER, 'Provider attempt time is invalid');
    boundedInteger(attempt.accepted, 0, options?.questionCount ?? 200, 'Provider attempt accepted count is invalid');
    if (!['failed', 'completed', 'manually-selected'].includes(attempt.outcome)) throw new Error('Provider attempt outcome is invalid');
    if (attempt.errorCode !== undefined && !boundedText(attempt.errorCode, 1, 100)) throw new Error('Provider attempt error code is invalid');
    if (attempt.message !== undefined && !boundedText(attempt.message, 1, 2_000)) throw new Error('Provider attempt message is invalid');
    if (routes) {
      const route = routes[attempt.routeIndex];
      if (!route || route.provider !== attempt.provider || (route.model ?? undefined) !== (attempt.model ?? undefined)) {
        throw new Error('Provider attempt does not match its route-chain entry');
      }
    }
  }
  return input;
};

export const validateProviderAttemptTransition = (input, previous, options, acceptedCount) => {
  validateProviderAttempts(input, options);
  const prior = previous ?? [];
  if (input.length < prior.length || input.length > prior.length + 1) {
    throw new Error('Provider attempt history is append-only');
  }
  if (prior.some((attempt, index) => !isDeepStrictEqual(attempt, input[index]))) {
    throw new Error('Existing provider attempts cannot be removed or changed');
  }
  if (input.length > prior.length && input.at(-1).accepted !== acceptedCount) {
    throw new Error('A provider attempt must record the current accepted-question checkpoint');
  }
  return input;
};

export const validateGenerationRejections = input => {
  if (!Array.isArray(input) || input.length > 5_000) {
    throw new Error('Generation rejections must be an array of at most 5000 events');
  }
  for (const rejection of input) {
    requireObject(rejection, 'Generation rejection must be an object');
    rejectUnknown(rejection, new Set(['at', 'type', 'round', 'reason', 'count', 'statement']), 'Generation rejection');
    boundedInteger(rejection.at, 0, Number.MAX_SAFE_INTEGER, 'Generation rejection time is invalid');
    if (!questionTypes.has(rejection.type)) throw new Error('Generation rejection question type is invalid');
    boundedInteger(rejection.round, 1, 5, 'Generation rejection round is invalid');
    if (!rejectionReasons.has(rejection.reason)) throw new Error('Generation rejection reason is invalid');
    boundedInteger(rejection.count, 1, 200, 'Generation rejection count is invalid');
    if (rejection.statement !== undefined && !boundedText(rejection.statement, 1, 500)) {
      throw new Error('Generation rejection statement is invalid');
    }
  }
  return input;
};

export const validateGenerationRejectionTransition = (input, previous) => {
  validateGenerationRejections(input);
  const prior = previous ?? [];
  if (input.length < prior.length || prior.some((rejection, index) => !isDeepStrictEqual(rejection, input[index]))) {
    throw new Error('Generation rejection history is append-only');
  }
  return input;
};

export const validateGenerationProgress = (input, options) => {
  const progress = requireObject(input, 'Generation progress must be an object');
  rejectUnknown(progress, new Set([
    'accepted', 'target', 'round', 'maxRounds', 'rejected', 'currentType', 'typeAccepted',
    'typeTarget', 'phase', 'provider', 'parallelRequests',
  ]), 'Generation progress');
  for (const key of ['accepted', 'target', 'typeAccepted', 'typeTarget']) {
    boundedInteger(progress[key], 0, options?.questionCount ?? 200, `Generation progress ${key} is invalid`);
  }
  boundedInteger(progress.round, 1, 5, 'Generation progress round is invalid');
  boundedInteger(progress.maxRounds, 1, 5, 'Generation progress maximum rounds is invalid');
  boundedInteger(progress.rejected, 0, 1_000_000, 'Generation progress rejected count is invalid');
  if (progress.currentType !== undefined && !questionTypes.has(progress.currentType)) throw new Error('Generation progress question type is invalid');
  if (!['requesting', 'validating'].includes(progress.phase)) throw new Error('Generation progress phase is invalid');
  if (!generationProviders.has(progress.provider)) throw new Error('Generation progress provider is invalid');
  if (progress.parallelRequests !== undefined) boundedInteger(progress.parallelRequests, 1, 10, 'Generation parallel request count is invalid');
  if (progress.accepted > progress.target || progress.typeAccepted > progress.typeTarget) throw new Error('Generation progress exceeds its target');
  return progress;
};

export const validateCoveragePlan = (input, documentIds, questionCount) => {
  const plan = requireObject(input, 'Generation coverage plan must be an object');
  rejectUnknown(plan, new Set(['strategy', 'createdAt', 'slots']), 'Generation coverage plan');
  if (!coverageStrategies.has(plan.strategy)) throw new Error('Generation coverage strategy is invalid');
  boundedInteger(plan.createdAt, 0, Number.MAX_SAFE_INTEGER, 'Generation coverage plan time is invalid');
  if (!Array.isArray(plan.slots) || plan.slots.length !== questionCount) throw new Error('Generation coverage slots must match the question count');
  const allowedDocuments = new Set(documentIds);
  for (const slot of plan.slots) {
    requireObject(slot, 'Generation coverage slot must be an object');
    rejectUnknown(slot, new Set(['documentIds', 'chunkIndexes']), 'Generation coverage slot');
    if (!Array.isArray(slot.documentIds) || !slot.documentIds.length || slot.documentIds.length > 20
      || slot.documentIds.some(id => !allowedDocuments.has(id)) || new Set(slot.documentIds).size !== slot.documentIds.length) {
      throw new Error('Generation coverage slot document ids are invalid');
    }
    requireObject(slot.chunkIndexes, 'Generation coverage chunk indexes must be an object');
    if (Object.keys(slot.chunkIndexes).some(id => !slot.documentIds.includes(id))) throw new Error('Generation coverage contains an out-of-scope chunk index');
    for (const index of Object.values(slot.chunkIndexes)) boundedInteger(index, 0, 10_000_000, 'Generation coverage chunk index is invalid');
  }
  return plan;
};

export const validateNewGenerationJob = input => {
  const job = requireObject(input, 'Generation job must be an object');
  rejectUnknown(job, new Set([
    'id', 'testId', 'name', 'createdAt', 'updatedAt', 'status', 'documentIds', 'options', 'questions', 'rejected', 'rounds',
  ]), 'New generation job');
  for (const key of ['id', 'testId']) if (!boundedText(job[key], 1, 100)) throw new Error(`Generation job ${key} is invalid`);
  if (!boundedText(job.name, 1, 200)) throw new Error('Generation job name must contain 1-200 characters');
  for (const key of ['createdAt', 'updatedAt']) boundedInteger(job[key], 0, Number.MAX_SAFE_INTEGER, `Generation job ${key} is invalid`);
  if (job.status !== 'queued') throw new Error('New generation jobs must be queued');
  if (!Array.isArray(job.documentIds) || !job.documentIds.length || job.documentIds.length > 10_000
    || job.documentIds.some(id => !boundedText(id, 1, 500)) || new Set(job.documentIds).size !== job.documentIds.length) {
    throw new Error('Generation job document ids are invalid');
  }
  validateGenerationOptions(job.options, { requireSnapshots: true, requireCompleteSettings: true });
  if (!Array.isArray(job.questions) || job.questions.length) throw new Error('New generation jobs must start without questions');
  if (job.rejected !== 0) throw new Error('New generation jobs must start without rejected questions');
  if (!isObject(job.rounds) || Object.keys(job.rounds).length) throw new Error('New generation jobs must start without generation rounds');
  return job;
};

export const isModernGenerationOptions = options => Boolean(
  options?.ragProfile || options?.promptProfileSnapshot || options?.resolvedSettings || options?.routeChain,
);

export const validateActiveRoute = (index, options) => {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Active route index must be a non-negative integer');
  if (options?.routeChain) {
    const route = options.routeChain[index];
    if (!route || !routeMatchesOptions(route, options)) throw new Error('Active route index does not match the selected provider route');
  }
  return index;
};
