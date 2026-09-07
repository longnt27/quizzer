import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGenerationCoveragePlan, executeGenerationJob, extractGenerationJson,
  GenerationJobWorker, generationQuestionSchemas, requestedQuestionCounts, validGeneratedCandidate,
} from '../server/generation-worker.mjs';
import {
  validateCoveragePlan, validateGenerationRejectionTransition, validateProviderAttemptTransition,
} from '../server/generation-validation.mjs';
import { validateQuestionCheckpoint } from '../server/question-validation.mjs';

const documents = [
  {
    id: 'doc-one', name: 'Coordination one', content: 'A lease grants one writer exclusive ownership. The writer releases it in a finally block.',
    chunks: [{ id: 'doc-one:span:0:a', index: 0, start: 0, end: 88 }],
  },
  {
    id: 'doc-two', name: 'Coordination two', content: 'Waiting writers retry only after the current lease holder has committed the protected state update.',
    chunks: [{ id: 'doc-two:span:0:b', index: 0, start: 0, end: 95 }],
  },
];

const optionsFor = ({ provider = 'codex', questionCounts, routeChain } = {}) => {
  const counts = questionCounts ?? { multipleChoice: 1, fillBlank: 1, reasoning: 1, coding: 1 };
  return {
    provider,
    questionCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    questionCounts: counts,
    multipleChoiceMode: 'single',
    coverageStrategy: 'cross-document',
    customInstruction: 'Focus on leases and coordination.',
    promptProfileSnapshot: {
      id: 'test-profile', version: 1, name: 'Test profile',
      template: 'Create {{count}} {{questionType}} items. {{typeInstructions}} {{multipleChoiceRule}} {{instruction}} Avoid: {{acceptedQuestions}}',
    },
    ragProfile: { id: 'balanced', retrieval: 'hybrid', contextBudget: 4096, rerank: true },
    routeChain: routeChain ?? [{ provider, privacy: 'signed-in-agent', paid: false, approved: true }],
    resolvedSettings: { 'generation.batchSize': 5, 'retrieval.contextBudget': 4096 },
  };
};

const candidateFor = (type, sequence = 1) => {
  if (type === 'fill-blank') return {
    type, statement: `A safe coordination pattern ${sequence} uses _____ before shared writes.`,
    acceptedAnswers: [`lease ${sequence}`, `lock ${sequence}`, `mutex ${sequence}`],
    explanation: 'Exclusive ownership serializes the protected update.',
  };
  if (type === 'reasoning') return {
    type, statement: `Why does coordination pattern ${sequence} prevent conflicting writes?`,
    referenceAnswer: 'It grants exclusive ownership so only one writer can commit the protected state update at a time.',
    explanation: 'The answer connects exclusive ownership with serialization.',
  };
  if (type === 'coding') return {
    type, statement: `Implement coordination pattern ${sequence} with guaranteed release after the update.`,
    referenceAnswer: 'await lock.acquire(); try { await update(); } finally { lock.release(); }',
    explanation: 'The finally block releases exclusive ownership even after failures.',
  };
  return {
    type, statement: `Which coordination behavior ${sequence} prevents conflicting shared-state writes?`,
    answer: [
      { correct: true, content: `Acquire lease ${sequence}`, explanation: 'The lease serializes writers before shared-state changes.' },
      { correct: false, content: `Delete state ${sequence}`, explanation: 'Deleting state loses evidence without serializing writers.' },
      { correct: false, content: `Retry blindly ${sequence}`, explanation: 'Blind retries can reproduce the same write conflict.' },
    ],
  };
};

const createHarness = (job, requestProvider) => {
  let state = structuredClone(job);
  let timestamp = 10_000;
  let completion;
  const patches = [];
  return {
    dependencies: {
      leaseRenewMs: 0,
      now: () => timestamp++,
      loadDocuments: ids => ids.map(id => documents.find(document => document.id === id)).filter(Boolean),
      ensureIndexed: values => assert.equal(values.length, job.documentIds.length),
      retrieve: ({ documentIds }) => ({ results: documentIds.map(id => {
        const document = documents.find(item => item.id === id);
        return {
          sourceSpanId: `${id}:span:0:${id === 'doc-one' ? 'a' : 'b'}`,
          documentId: id,
          documentName: document.name,
          content: document.content,
        };
      }) }),
      loadImage: () => undefined,
      requestProvider,
      update: (_leased, patch) => {
        const nextOptions = patch.options ?? state.options;
        if (patch.coveragePlan) validateCoveragePlan(patch.coveragePlan, state.documentIds, state.options.questionCount);
        if (patch.questions) validateQuestionCheckpoint(patch.questions, { ...state, options: nextOptions });
        if (patch.providerAttempts) validateProviderAttemptTransition(
          patch.providerAttempts, state.providerAttempts, nextOptions, (patch.questions ?? state.questions).length,
        );
        if (patch.rejections) validateGenerationRejectionTransition(patch.rejections, state.rejections);
        state = { ...state, ...structuredClone(patch), updatedAt: timestamp++ };
        patches.push(structuredClone(patch));
        return state;
      },
      renew: () => state,
      getJob: () => state,
      complete: (_leased, value) => {
        validateQuestionCheckpoint(value.test.questions, { ...state, options: value.test.generationOptions });
        validateProviderAttemptTransition(
          value.patch.providerAttempts, state.providerAttempts, value.test.generationOptions, value.test.questions.length,
        );
        validateGenerationRejectionTransition(value.patch.rejections ?? [], state.rejections);
        completion = structuredClone(value);
        state = { ...state, ...value.patch, status: 'completed', completionId: value.completionId };
        return state;
      },
    },
    state: () => state,
    patches,
    completion: () => completion,
  };
};

test('service worker retrieves, validates, checkpoints, and atomically completes every question type', async () => {
  const options = optionsFor();
  const job = {
    id: 'job-complete', testId: 'test-complete', name: 'Service quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-complete', createdAt: 1, updatedAt: 1,
    documentIds: documents.map(document => document.id), options, questions: [], rejected: 0, rounds: {},
  };
  const requests = [];
  const harness = createHarness(job, request => {
    const type = request.schema.properties.questions.items.properties.type.enum[0];
    requests.push({ type, prompt: request.prompt, images: request.images });
    return JSON.stringify({ questions: [candidateFor(type, requests.length)] });
  });

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'completed');
  assert.deepEqual(requests.map(request => request.type), ['multiple-choice', 'fill-blank', 'reasoning', 'coding']);
  assert.ok(requests.every(request => request.prompt.includes('SECURITY RULES (protected by Quizzer')));
  assert.ok(requests.every(request => request.prompt.includes('Focus on leases and coordination.')));
  assert.ok(requests.every(request => request.prompt.includes('Source span: doc-')));
  assert.ok(requests.every(request => request.images.length === 0));
  assert.equal(harness.completion().test.questions.length, 4);
  assert.deepEqual(harness.completion().test.questions.map(question => question.provenance.coverageSlot), [0, 1, 2, 3]);
  assert.equal(harness.completion().test.fileContent.includes('Coordination two'), true);
  assert.equal(harness.completion().patch.providerAttempts.at(-1).outcome, 'completed');
  assert.ok(harness.completion().test.questions.every(question => question.provenance.sourceSpanIds.length >= 1));
  assert.ok(harness.patches.some(patch => patch.coveragePlan?.strategy === 'cross-document'));
  assert.deepEqual(requestedQuestionCounts(options), {
    'multiple-choice': 1, 'fill-blank': 1, reasoning: 1, coding: 1,
  });
});

test('service worker continues only unfinished slots through a pre-approved route', async () => {
  const routes = [
    { provider: 'codex', privacy: 'signed-in-agent', paid: false, approved: true },
    { provider: 'claude-agent', privacy: 'signed-in-agent', paid: false, approved: true },
  ];
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 }, routeChain: routes });
  const job = {
    id: 'job-failover', testId: 'test-failover', name: 'Failover quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-failover', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  const providers = [];
  const harness = createHarness(job, request => {
    providers.push(request.provider);
    if (request.provider === 'codex') throw Object.assign(new Error('Codex quota reached'), { code: 'provider_limit' });
    return JSON.stringify({ questions: [candidateFor('multiple-choice')] });
  });

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'completed');
  assert.deepEqual(providers, ['codex', 'claude-agent']);
  assert.equal(harness.completion().test.generationOptions.provider, 'claude-agent');
  assert.deepEqual(harness.completion().patch.providerAttempts.map(attempt => attempt.outcome), ['failed', 'completed']);
  assert.equal(harness.completion().patch.providerAttempts[0].accepted, 0);
  assert.equal(harness.completion().test.questions[0].provenance.provider, 'claude-agent');
});

test('service worker routes to openai-compatible provider and respects endpoint settings', async () => {
  const routes = [
    { provider: 'openai-compatible', model: 'custom-model', privacy: 'remote-api', paid: true, approved: true },
  ];
  const options = optionsFor({
    questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 },
    routeChain: routes,
  });
  options.provider = 'openai-compatible';
  options.model = 'custom-model';
  options.resolvedSettings = {
    ...options.resolvedSettings,
    'providers.openai-compatible.endpoint': 'http://127.0.0.1:8000/v1',
  };

  const job = {
    id: 'job-compat', testId: 'test-compat', name: 'OpenAI-compatible quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-compat', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  let capturedRequest;
  const harness = createHarness(job, request => {
    capturedRequest = request;
    return JSON.stringify({ questions: [candidateFor('multiple-choice')] });
  });

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(capturedRequest.provider, 'openai-compatible');
  assert.equal(capturedRequest.model, 'custom-model');
  assert.equal(capturedRequest.endpoint, 'http://127.0.0.1:8000/v1');
  assert.equal(harness.completion().test.questions[0].provenance.provider, 'openai-compatible');
  assert.equal(harness.completion().test.questions[0].provenance.model, 'custom-model');
});

test('service worker routes llama.cpp jobs to the local endpoint setting', async () => {
  const routes = [
    { provider: 'llama-cpp', model: 'llama-3.2-q4', privacy: 'local', paid: false, approved: true },
  ];
  const options = optionsFor({
    provider: 'llama-cpp',
    questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 },
    routeChain: routes,
  });
  options.model = 'llama-3.2-q4';
  options.resolvedSettings = {
    ...options.resolvedSettings,
    'providers.openai-compatible.endpoint': 'https://remote.example.test/v1',
    'providers.llama-cpp.endpoint': 'http://127.0.0.42:8080/v1',
  };
  const job = {
    id: 'job-llama-cpp', testId: 'test-llama-cpp', name: 'llama.cpp quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-llama-cpp', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  let capturedRequest;
  const harness = createHarness(job, request => {
    capturedRequest = request;
    return JSON.stringify({ questions: [candidateFor('multiple-choice')] });
  });
  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(capturedRequest.provider, 'llama-cpp');
  assert.equal(capturedRequest.endpoint, 'http://127.0.0.42:8080/v1');
  assert.equal(capturedRequest.resolvedSettings['providers.openai-compatible.endpoint'], 'https://remote.example.test/v1');
});

test('service worker pauses safely when no approved provider route remains', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const job = {
    id: 'job-paused', testId: 'test-paused', name: 'Paused quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-paused', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  const harness = createHarness(job, () => {
    throw Object.assign(new Error('Sign in again'), { code: 'provider_auth' });
  });

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'paused');
  assert.equal(result.errorCode, 'provider_auth');
  assert.equal(result.providerAttempts.length, 1);
  assert.equal(result.providerAttempts[0].outcome, 'failed');
});

test('service worker bounds provider failure details before checkpointing', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const job = {
    id: 'job-bounded-error', testId: 'test-bounded-error', name: 'Bounded error quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-bounded-error', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  const harness = createHarness(job, () => {
    throw Object.assign(new Error('x'.repeat(5_000)), { code: 'provider_limit' });
  });

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'paused');
  assert.equal(result.providerAttempts[0].message.length, 2_000);
  assert.equal(result.error.length, 4_000);
});

test('service worker uses local embeddings to reject semantic duplicates', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 2, fillBlank: 0, reasoning: 0, coding: 0 } });
  options.resolvedSettings['embeddings.enabled'] = true;
  const job = {
    id: 'job-semantic', testId: 'test-semantic', name: 'Semantic quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-semantic', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  let requestCount = 0;
  const harness = createHarness(job, () => {
    requestCount += 1;
    return JSON.stringify({ questions: [
      candidateFor('multiple-choice', requestCount * 2),
      candidateFor('multiple-choice', requestCount * 2 + 1),
    ] });
  });
  harness.dependencies.embed = texts => texts.map(() => [1, 0, 0]);

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'validation_exhausted');
  assert.equal(harness.completion(), undefined);
  assert.equal(harness.state().questions.length, 1);
  assert.equal(requestCount, 5);
  assert.ok(harness.state().rejected >= 5);
  assert.ok(harness.state().rejections.some(rejection => rejection.reason === 'duplicate'));
  assert.ok(harness.state().rejections.some(rejection => rejection.reason === 'out-of-coverage'));
});

test('service worker falls back to source chunks, carries images, and renews its lease', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const job = {
    id: 'job-fallback', testId: 'test-fallback', name: 'Fallback quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-fallback', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  const image = { id: 'figure-one', name: 'lease.png', mimeType: 'image/png' };
  documents[0].images = [image, image];
  let renewals = 0;
  const harness = createHarness(job, async request => {
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.deepEqual(request.images, ['data:image/png;base64,dGVzdA==']);
    return JSON.stringify({ questions: [candidateFor('multiple-choice')] });
  });
  harness.dependencies.retrieve = () => { throw new Error('Dense and sparse retrieval temporarily unavailable'); };
  harness.dependencies.loadImage = value => value === image ? 'data:image/png;base64,dGVzdA==' : undefined;
  harness.dependencies.leaseRenewMs = 2;
  harness.dependencies.renew = () => { renewals += 1; return harness.state(); };
  try {
    const result = await executeGenerationJob(job, harness.dependencies);
    assert.equal(result.status, 'completed');
    assert.ok(renewals >= 1);
    assert.match(harness.completion().test.questions[0].provenance.sourceSpanIds[0], /^doc-one:/);
  } finally {
    delete documents[0].images;
  }
});

test('service worker runs one corrective retrieval pass before generating', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const job = {
    id: 'job-corrective', testId: 'test-corrective', name: 'Corrective quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-corrective', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  const harness = createHarness(job, () => JSON.stringify({ questions: [candidateFor('multiple-choice')] }));
  let retrievals = 0;
  harness.dependencies.retrieve = () => {
    retrievals += 1;
    const evidence = [{
      sourceSpanId: 'doc-one:span:0:a', documentId: 'doc-one', documentName: 'Coordination one',
      content: documents[0].content,
    }];
    return retrievals === 1
      ? { confidence: 'low', refusal: 'Insufficient evidence', results: evidence }
      : { confidence: 'high', results: evidence };
  };

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(retrievals, 2);
});

test('service worker refuses after one unsuccessful corrective retrieval pass', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const job = {
    id: 'job-refusal', testId: 'test-refusal', name: 'Refusal quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-refusal', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  let retrievals = 0;
  let providerRequests = 0;
  const harness = createHarness(job, () => { providerRequests += 1; return '{}'; });
  harness.dependencies.retrieve = () => {
    retrievals += 1;
    return { confidence: 'low', refusal: 'Insufficient evidence', results: [] };
  };

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'insufficient_evidence');
  assert.match(result.error, /one corrective retrieval pass/);
  assert.equal(retrievals, 2);
  assert.equal(providerRequests, 0);
});

test('service worker audits an ungrounded candidate and refills only its slot', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 2, fillBlank: 0, reasoning: 0, coding: 0 } });
  const job = {
    id: 'job-grounding', testId: 'test-grounding', name: 'Grounding quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-grounding', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  let requests = 0;
  const harness = createHarness(job, () => {
    requests += 1;
    if (requests > 1) return JSON.stringify({ questions: [candidateFor('multiple-choice', 3)] });
    return JSON.stringify({ questions: [{
      type: 'multiple-choice', statement: 'Which pigment absorbs sunlight during photosynthesis?',
      answer: [
        { correct: true, content: 'Chlorophyll', explanation: 'Chlorophyll absorbs light energy for photosynthesis.' },
        { correct: false, content: 'Hemoglobin', explanation: 'Hemoglobin transports oxygen rather than absorbing sunlight.' },
        { correct: false, content: 'Keratin', explanation: 'Keratin provides structural support and is not a photosynthetic pigment.' },
      ],
    }, candidateFor('multiple-choice', 2)] });
  });

  const result = await executeGenerationJob(job, harness.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(requests, 2);
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.rejections.map(rejection => rejection.reason), ['ungrounded']);
  assert.match(result.rejections[0].statement, /pigment/);
  assert.deepEqual(result.questions.map(question => question.provenance.coverageSlot), [1, 0]);
});

test('service worker records missing sources, empty generations, and network waits', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const base = {
    id: 'job-failure', testId: 'test-failure', name: 'Failure quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-failure', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };

  const missing = createHarness(base, () => '{}');
  missing.dependencies.loadDocuments = () => [];
  assert.equal((await executeGenerationJob(base, missing.dependencies)).error, 'One or more source documents were deleted before generation completed.');

  const empty = createHarness({ ...base, id: 'job-empty' }, () => '{"questions":[]}');
  const emptyResult = await executeGenerationJob({ ...base, id: 'job-empty' }, empty.dependencies);
  assert.equal(emptyResult.status, 'error');
  assert.equal(emptyResult.errorCode, 'validation_exhausted');
  assert.match(emptyResult.error, /validated 0 of 1/);
  assert.equal(emptyResult.rejections.reduce((sum, rejection) => sum + rejection.count, 0), 5);

  const disconnected = createHarness({ ...base, id: 'job-waiting' }, () => { throw new Error('Network socket connection failed'); });
  const waitingResult = await executeGenerationJob({ ...base, id: 'job-waiting' }, disconnected.dependencies);
  assert.equal(waitingResult.status, 'waiting');
  assert.equal(waitingResult.errorCode, 'connection_lost');
  assert.ok(waitingResult.nextAttemptAt > waitingResult.updatedAt);
});

test('generation worker pumps claimed jobs and isolates claim failures', async () => {
  assert.throws(() => new GenerationJobWorker({}), /requires a claim function/);
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const job = {
    id: 'job-pump', testId: 'test-pump', name: 'Pumped quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-pump', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, activeRouteIndex: 0,
  };
  let resolveCompletion;
  const completed = new Promise(resolve => { resolveCompletion = resolve; });
  const harness = createHarness(job, () => JSON.stringify({ questions: [candidateFor('multiple-choice')] }));
  const originalComplete = harness.dependencies.complete;
  harness.dependencies.complete = (...args) => {
    const result = originalComplete(...args);
    resolveCompletion(result);
    return result;
  };
  let claimed = false;
  const errors = [];
  const worker = new GenerationJobWorker({
    ...harness.dependencies,
    intervalMs: 60_000,
    claim: () => {
      if (claimed) return undefined;
      claimed = true;
      return job;
    },
    onError: (id, error) => errors.push({ id, error }),
  });
  worker.start();
  worker.start();
  await completed;
  worker.cancel('not-active');
  worker.poke();
  worker.stop();
  assert.equal(errors.length, 0);

  const failedClaims = [];
  const failingWorker = new GenerationJobWorker({
    claim: () => { throw new Error('claim failed'); },
    onError: (id, error) => failedClaims.push({ id, message: error.message }),
  });
  await failingWorker.pump();
  failingWorker.stop();
  assert.deepEqual(failedClaims, [{ id: 'claim', message: 'claim failed' }]);
});

test('bounds schemas, candidates, JSON extraction, and coverage inputs', () => {
  assert.equal(generationQuestionSchemas.coding.properties.questions.items.properties.type.enum[0], 'coding');
  assert.deepEqual(extractGenerationJson('before {"questions":[]} after'), []);
  assert.deepEqual(extractGenerationJson(null), []);
  assert.deepEqual(extractGenerationJson('not json'), []);
  assert.deepEqual(extractGenerationJson('```json\n{"questions":[{"type":"reasoning"}]}\n```').length, 1);
  assert.equal(validGeneratedCandidate(candidateFor('multiple-choice'), 'multiple-choice', 'single'), true);
  assert.equal(validGeneratedCandidate({ ...candidateFor('multiple-choice'), hidden: true }, 'multiple-choice'), false);
  assert.equal(validGeneratedCandidate({ ...candidateFor('multiple-choice'), statement: 'According to this lesson, which lock is used?' }, 'multiple-choice'), false);
  assert.equal(validGeneratedCandidate({ ...candidateFor('multiple-choice'), answer: [
    { correct: true, content: 'Lock', explanation: 'This explanation has enough detail.' },
    { correct: false, content: 'An implausibly long answer whose conspicuous verbosity reveals the intended choice without subject knowledge', explanation: 'This explanation has enough detail.' },
    { correct: false, content: 'Retry', explanation: 'This explanation has enough detail.' },
  ] }, 'multiple-choice'), false);
  assert.equal(validGeneratedCandidate({ ...candidateFor('fill-blank'), acceptedAnswers: ['same', 'SAME', 'third'] }, 'fill-blank'), false);
  assert.throws(() => buildGenerationCoveragePlan([], 1), /no usable text chunks/);
  const plan = buildGenerationCoveragePlan(documents, 5, 'proportional', 123);
  assert.equal(plan.createdAt, 123);
  assert.equal(plan.slots.length, 5);
  assert.equal(buildGenerationCoveragePlan(documents, 2, 'ai-selected').slots.length, 2);
  assert.equal(requestedQuestionCounts({ questionCount: 3 })['multiple-choice'], 3);
});

test('does not replay a provider request after an accounting attempt was recorded', async () => {
  const options = optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } });
  const base = {
    id: 'job-recovery', testId: 'test-recovery', name: 'Recovery quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-recovery', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, providerAttempts: [],
  };
  const order = [];
  const first = createHarness(base, () => {
    order.push('request');
    throw new Error('provider disconnected after dispatch');
  });
  first.dependencies.reserveGenerationAttempt = (id, params) => {
    order.push('reserve');
    first.dependencies.reserveGenerationAttempt.lastAttemptId = params.attemptId;
    return { ...base, usageAudit: [{ attemptId: params.attemptId, event: 'reserved' }] };
  };
  first.dependencies.finalizeGenerationAttempt = (id, params) => {
    order.push('finalize');
    return { ...base, usageAudit: [{ attemptId: params.attemptId, event: 'finalized' }] };
  };
  await executeGenerationJob(base, first.dependencies);
  assert.deepEqual(order, ['reserve', 'request', 'finalize']);
  // Capture the deterministic ID from the finalize call without exposing the
  // worker's internal ID-generation helper.
  const recordedId = first.dependencies.reserveGenerationAttempt.lastAttemptId;
  assert.ok(recordedId);
  const replay = createHarness({ ...base, usageAudit: [{ attemptId: recordedId, event: 'reserved' }] }, () => {
    throw new Error('must not dispatch');
  });
  let reserves = 0;
  replay.dependencies.reserveGenerationAttempt = () => { reserves += 1; throw new Error('must not reserve'); };
  replay.dependencies.finalizeGenerationAttempt = () => { throw new Error('must not finalize'); };
  const result = await executeGenerationJob({ ...base, usageAudit: [{ attemptId: recordedId, event: 'reserved' }] }, replay.dependencies);
  assert.equal(result.status, 'paused');
  assert.equal(result.errorCode, 'cost_recovery');
  assert.equal(reserves, 0);
  assert.equal(replay.patches.some(patch => patch.errorCode === 'cost_recovery'), true);
  const approvedAudit = [{ attemptId: recordedId, event: 'reserved' }, { event: 'recovery-approved', recoveryAttemptId: recordedId }];
  const approvedJob = { ...base, usageAudit: approvedAudit };
  const retry = createHarness(approvedJob, () => { throw new Error('provider disconnected again'); });
  retry.dependencies.reserveGenerationAttempt = (_id, params) => {
    retry.dependencies.newAttemptId = params.attemptId;
    return { ...approvedJob, usageAudit: [...approvedAudit, { attemptId: params.attemptId, event: 'reserved' }] };
  };
  retry.dependencies.finalizeGenerationAttempt = (_id, params) => ({ ...approvedJob, usageAudit: [...approvedAudit,
    { attemptId: params.attemptId, event: 'reserved' }, { attemptId: params.attemptId, event: 'finalized' }] });
  const retried = await executeGenerationJob(approvedJob, retry.dependencies);
  assert.notEqual(retry.dependencies.newAttemptId, recordedId);
  assert.equal(retried.status, 'error');
  const secondApprovalAudit = [...approvedAudit,
    { attemptId: retry.dependencies.newAttemptId, event: 'reserved' },
    { event: 'recovery-approved', recoveryAttemptId: retry.dependencies.newAttemptId }];
  const third = createHarness({ ...base, usageAudit: secondApprovalAudit }, () => { throw new Error('third dispatch failed'); });
  third.dependencies.reserveGenerationAttempt = (_id, params) => {
    third.dependencies.newAttemptId = params.attemptId;
    return { ...base, usageAudit: [...secondApprovalAudit, { attemptId: params.attemptId, event: 'reserved' }] };
  };
  third.dependencies.finalizeGenerationAttempt = (_id, params) => ({ ...base, usageAudit: [...secondApprovalAudit,
    { attemptId: params.attemptId, event: 'reserved' }, { attemptId: params.attemptId, event: 'finalized' }] });
  await executeGenerationJob({ ...base, usageAudit: secondApprovalAudit }, third.dependencies);
  assert.notEqual(third.dependencies.newAttemptId, retry.dependencies.newAttemptId);
  assert.notEqual(third.dependencies.newAttemptId, recordedId);
});

test('pauses finite-ceiling jobs for both reserved and finalized replay attempts', async () => {
  const options = {
    ...optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } }),
    costCeilingMicroUsd: 10_000_000,
  };
  const base = {
    id: 'job-finite-recovery', testId: 'test-finite-recovery', name: 'Finite recovery quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-finite-recovery', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options, questions: [], rejected: 0, rounds: {}, providerAttempts: [],
  };
  for (const event of ['reserved', 'finalized']) {
    const calls = [];
    const first = createHarness(base, () => {
      calls.push('request');
      return JSON.stringify({ questions: [candidateFor('multiple-choice')] });
    });
    first.dependencies.reserveGenerationAttempt = (_id, params) => {
      calls.push('reserve');
      first.dependencies.reserveGenerationAttempt.lastAttemptId = params.attemptId;
      return { ...base, usageAudit: [{ attemptId: params.attemptId, event: 'reserved' }] };
    };
    first.dependencies.finalizeGenerationAttempt = (_id, params) => {
      calls.push('finalize');
      return { ...base, usageAudit: [{ attemptId: params.attemptId, event: 'finalized' }] };
    };
    const completed = await executeGenerationJob(base, first.dependencies);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(calls, ['reserve', 'request', 'finalize']);
    const attemptId = first.dependencies.reserveGenerationAttempt.lastAttemptId;

    const replayCalls = [];
    const replay = createHarness({ ...base, usageAudit: [{ attemptId, event }] }, () => {
      replayCalls.push('request');
      throw new Error('must not dispatch');
    });
    replay.dependencies.reserveGenerationAttempt = () => { replayCalls.push('reserve'); throw new Error('must not reserve'); };
    replay.dependencies.finalizeGenerationAttempt = () => { replayCalls.push('finalize'); throw new Error('must not finalize'); };
    const result = await executeGenerationJob({ ...base, usageAudit: [{ attemptId, event }] }, replay.dependencies);
    assert.equal(result.status, 'paused');
    assert.equal(result.errorCode, 'cost_recovery');
    assert.deepEqual(replayCalls, []);
    assert.match(result.error, /may have been charged.*not checkpointed/i);
  }
});

test('covers accounting pause failures, envelopes, null responses, and cancellation', async () => {
  const base = {
    id: 'job-branch-coverage', testId: 'test-branch-coverage', name: 'Branch quiz', status: 'running',
    workerId: 'service-worker', leaseId: 'lease-branch', createdAt: 1, updatedAt: 1,
    documentIds: ['doc-one'], options: optionsFor({ questionCounts: { multipleChoice: 1, fillBlank: 0, reasoning: 0, coding: 0 } }),
    questions: [], rejected: 0, rounds: {}, providerAttempts: [],
  };
  const finite = { ...base, options: { ...base.options, costCeilingMicroUsd: 100 } };
  let requests = 0;
  const reserveBlocked = createHarness(finite, () => { requests += 1; return '{}'; });
  reserveBlocked.dependencies.reserveGenerationAttempt = () => { throw new Error('ceiling exhausted'); };
  reserveBlocked.dependencies.finalizeGenerationAttempt = () => { throw new Error('must not finalize'); };
  const blocked = await executeGenerationJob(finite, reserveBlocked.dependencies);
  assert.equal(blocked.errorCode, 'cost_ceiling');
  assert.equal(requests, 0);

  requests = 0;
  const unavailable = createHarness(finite, () => { requests += 1; return '{}'; });
  const unavailableResult = await executeGenerationJob(finite, unavailable.dependencies);
  assert.equal(unavailableResult.errorCode, 'cost_ceiling');
  assert.equal(requests, 0);

  const calls = [];
  const envelope = createHarness(base, () => {
    calls.push('request');
    return { output: JSON.stringify({ questions: [candidateFor('multiple-choice')] }), usage: {
      inputTokens: 2, outputTokens: 3, totalTokens: 5,
    } };
  });
  envelope.dependencies.reserveGenerationAttempt = (_id, params) => {
    calls.push('reserve');
    return { ...base, usageAudit: [{ attemptId: params.attemptId, event: 'reserved' }] };
  };
  envelope.dependencies.finalizeGenerationAttempt = () => { calls.push('finalize'); return base; };
  const completed = await executeGenerationJob(base, envelope.dependencies);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(calls, ['reserve', 'request', 'finalize']);

  const cancelled = createHarness(base, () => { throw new Error('must not dispatch'); });
  const signal = new AbortController();
  signal.abort(Object.assign(new Error('cancelled by test'), { name: 'AbortError' }));
  await assert.rejects(executeGenerationJob(base, { ...cancelled.dependencies, signal: signal.signal }), /cancelled by test/);

  const alreadyOver = createHarness({ ...finite, usageSummary: {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, finalizedCostMicroUsd: 101, reservedCostMicroUsd: 0,
  } }, () => { throw new Error('must not dispatch'); });
  const overResult = await executeGenerationJob({ ...finite, usageSummary: {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, finalizedCostMicroUsd: 101, reservedCostMicroUsd: 0,
  } }, alreadyOver.dependencies);
  assert.equal(overResult.errorCode, 'cost_ceiling');

  const unlimitedReserveFailure = createHarness(base, () => { throw new Error('must not dispatch'); });
  unlimitedReserveFailure.dependencies.reserveGenerationAttempt = () => { throw new Error('accounting unavailable'); };
  const accountingFailure = await executeGenerationJob(base, unlimitedReserveFailure.dependencies);
  assert.equal(accountingFailure.status, 'error');

  const invalid = createHarness(base, () => JSON.stringify({ questions: [{}] }));
  const invalidResult = await executeGenerationJob(base, invalid.dependencies);
  assert.equal(invalidResult.errorCode, 'validation_exhausted');

  const embedding = createHarness(base, () => JSON.stringify({ questions: [candidateFor('multiple-choice')] }));
  embedding.dependencies.embed = async () => { throw new Error('embedding unavailable'); };
  embedding.state().options.resolvedSettings['embeddings.enabled'] = true;
  const embeddingResult = await executeGenerationJob(base, embedding.dependencies);
  assert.equal(embeddingResult.status, 'completed');

  const legacy = {
    ...base,
    id: 'job-legacy-slots', testId: 'test-legacy-slots',
    options: { ...base.options, questionCount: 2, questionCounts: { multipleChoice: 2, fillBlank: 0, reasoning: 0, coding: 0 } },
    questions: [candidateFor('multiple-choice', 99)],
  };
  const legacyHarness = createHarness(legacy, () => JSON.stringify({ questions: [candidateFor('multiple-choice', 100)] }));
  const legacyResult = await executeGenerationJob(legacy, legacyHarness.dependencies);
  assert.ok(['completed', 'error'].includes(legacyResult.status));

  const nullResponse = createHarness({ ...base, id: 'job-null-response' }, () => null);
  const nullResult = await executeGenerationJob({ ...base, id: 'job-null-response' }, nullResponse.dependencies);
  assert.equal(nullResult.errorCode, 'validation_exhausted');

  const legacyAudit = createHarness({ ...base, id: 'job-legacy-audit', usageAudit: [{ attemptId: 'other-attempt', event: 'reserved' }] },
    () => JSON.stringify({ questions: [candidateFor('multiple-choice', 501)] }));
  const legacyAuditResult = await executeGenerationJob({ ...base, id: 'job-legacy-audit', usageAudit: [{ attemptId: 'other-attempt', event: 'reserved' }] }, legacyAudit.dependencies);
  assert.ok(['completed', 'error'].includes(legacyAuditResult.status));

  const undefinedAccounting = createHarness({ ...base, id: 'job-undefined-accounting' },
    () => JSON.stringify({ questions: [candidateFor('multiple-choice', 601)] }));
  undefinedAccounting.dependencies.reserveGenerationAttempt = () => undefined;
  undefinedAccounting.dependencies.finalizeGenerationAttempt = () => undefined;
  const undefinedAccountingResult = await executeGenerationJob({ ...base, id: 'job-undefined-accounting' }, undefinedAccounting.dependencies);
  assert.equal(undefinedAccountingResult.status, 'completed');

  const aliasAccounting = createHarness({ ...base, id: 'job-alias-accounting' },
    () => JSON.stringify({ questions: [candidateFor('multiple-choice', 701)] }));
  aliasAccounting.dependencies.reserveProviderAttempt = () => undefined;
  aliasAccounting.dependencies.finalizeProviderAttempt = () => undefined;
  const aliasResult = await executeGenerationJob({ ...base, id: 'job-alias-accounting' }, aliasAccounting.dependencies);
  assert.equal(aliasResult.status, 'completed');

  const finalizeFailure = createHarness({ ...base, id: 'job-finalize-failure' },
    () => JSON.stringify({ questions: [candidateFor('multiple-choice', 801)] }));
  finalizeFailure.dependencies.reserveGenerationAttempt = () => undefined;
  finalizeFailure.dependencies.finalizeGenerationAttempt = () => { throw new Error('finalization unavailable'); };
  const finalizeFailureResult = await executeGenerationJob({ ...base, id: 'job-finalize-failure' }, finalizeFailure.dependencies);
  assert.equal(finalizeFailureResult.status, 'error');

  const optionalDeps = createHarness({ ...base, id: 'job-optional-deps' },
    () => JSON.stringify({ questions: [candidateFor('multiple-choice', 901)] }));
  delete optionalDeps.dependencies.ensureIndexed;
  delete optionalDeps.dependencies.retrieve;
  delete optionalDeps.dependencies.loadImage;
  const optionalResult = await executeGenerationJob({ ...base, id: 'job-optional-deps' }, optionalDeps.dependencies);
  assert.equal(optionalResult.status, 'completed');
});
