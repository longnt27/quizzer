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
