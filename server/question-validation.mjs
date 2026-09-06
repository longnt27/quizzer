const questionTypes = new Set(['multiple-choice', 'fill-blank', 'reasoning', 'coding']);
const boundedText = (value, minimum = 1, maximum = 50_000) => typeof value === 'string'
  && value.trim().length >= minimum && value.length <= maximum;

const expectedCounts = options => {
  if (options?.questionCounts && typeof options.questionCounts === 'object') {
    return {
      'multiple-choice': options.questionCounts.multipleChoice,
      'fill-blank': options.questionCounts.fillBlank,
      reasoning: options.questionCounts.reasoning,
      coding: options.questionCounts.coding,
    };
  }
  return { 'multiple-choice': options?.questionCount, 'fill-blank': 0, reasoning: 0, coding: 0 };
};

const coverageRange = (type, expected) => {
  const ordered = ['multiple-choice', 'fill-blank', 'reasoning', 'coding'];
  const index = ordered.indexOf(type);
  const start = ordered.slice(0, index).reduce((sum, item) => sum + expected[item], 0);
  return { start, end: start + expected[type] };
};

const validateProvenance = (provenance, allowedDocumentIds, questionCount) => {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('Question provenance is required');
  const unsupported = Object.keys(provenance).filter(key => !['documentIds', 'sourceSpanIds', 'coverageSlot', 'provider', 'model'].includes(key));
  if (unsupported.length) throw new Error(`Question provenance contains unsupported fields: ${unsupported.join(', ')}`);
  if (!Array.isArray(provenance.documentIds) || !provenance.documentIds.length || provenance.documentIds.length > 20
    || provenance.documentIds.some(id => !boundedText(id, 1, 500) || !allowedDocumentIds.has(id))) {
    throw new Error('Question provenance contains invalid document ids');
  }
  const documentIds = new Set(provenance.documentIds);
  if (documentIds.size !== provenance.documentIds.length) throw new Error('Question provenance document ids must be unique');
  if (!Array.isArray(provenance.sourceSpanIds) || !provenance.sourceSpanIds.length || provenance.sourceSpanIds.length > 50
    || provenance.sourceSpanIds.some(id => !boundedText(id, 1, 1_000) || ![...documentIds].some(documentId => id.startsWith(`${documentId}:`)))) {
    throw new Error('Question provenance contains invalid source-span ids');
  }
  if (new Set(provenance.sourceSpanIds).size !== provenance.sourceSpanIds.length) {
    throw new Error('Question provenance source-span ids must be unique');
  }
  if (provenance.coverageSlot !== undefined && (!Number.isSafeInteger(provenance.coverageSlot)
    || provenance.coverageSlot < 0 || provenance.coverageSlot >= questionCount)) {
    throw new Error('Question provenance coverage slot is invalid');
  }
  for (const key of ['provider', 'model']) {
    if (provenance[key] !== undefined && !boundedText(provenance[key], 1, 200)) throw new Error(`Question provenance ${key} is invalid`);
  }
};

const validateStrictQuestion = (question, options) => {
  const type = question.type ?? 'multiple-choice';
  if (!questionTypes.has(type)) throw new Error(`Unsupported question type: ${type}`);
  const allowedFields = type === 'multiple-choice'
    ? ['type', 'statement', 'answer', 'provenance']
    : type === 'fill-blank'
      ? ['type', 'statement', 'acceptedAnswers', 'explanation', 'provenance']
      : ['type', 'statement', 'referenceAnswer', 'explanation', 'provenance'];
  const unsupported = Object.keys(question).filter(key => !allowedFields.includes(key));
  if (unsupported.length) throw new Error(`Question contains unsupported fields: ${unsupported.join(', ')}`);
  if (type === 'multiple-choice') {
    if (!Array.isArray(question.answer) || question.answer.length < 3 || question.answer.length > 6) {
      throw new Error('Multiple-choice questions require 3-6 answers');
    }
    const normalizedChoices = new Set();
    let correct = 0;
    for (const answer of question.answer) {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.correct !== 'boolean'
        || !boundedText(answer.content, 1, 10_000) || !boundedText(answer.explanation, 1, 20_000)) {
        throw new Error('Multiple-choice answers are invalid');
      }
      if (Object.keys(answer).some(key => !['correct', 'content', 'explanation'].includes(key))) {
        throw new Error('Multiple-choice answers contain unsupported fields');
      }
      const normalized = answer.content.normalize('NFKC').toLocaleLowerCase().trim();
      if (normalizedChoices.has(normalized)) throw new Error('Multiple-choice answers must be unique');
      normalizedChoices.add(normalized);
      if (answer.correct) correct += 1;
    }
    if (correct < 1 || correct >= question.answer.length) throw new Error('Multiple-choice questions need correct and incorrect answers');
    if (options?.multipleChoiceMode === 'single' && correct !== 1) throw new Error('Single-answer questions require exactly one correct answer');
    if (options?.multipleChoiceMode === 'multiple' && correct < 2) throw new Error('Multiple-answer questions require at least two correct answers');
    return type;
  }
  if (type === 'fill-blank') {
    if (!question.statement.includes('_____') || !Array.isArray(question.acceptedAnswers)
      || question.acceptedAnswers.length < 3 || question.acceptedAnswers.length > 16
      || question.acceptedAnswers.some(answer => !boundedText(answer, 1, 2_000))
      || !boundedText(question.explanation, 1, 20_000)) throw new Error('Fill-in-the-blank question fields are invalid');
    const normalizedAnswers = question.acceptedAnswers.map(answer => answer.normalize('NFKC').toLocaleLowerCase().trim());
    if (new Set(normalizedAnswers).size !== normalizedAnswers.length) throw new Error('Accepted fill-in answers must be unique');
    return type;
  }
  if (!boundedText(question.referenceAnswer, 20, 50_000) || !boundedText(question.explanation, 1, 20_000)) {
    throw new Error(`${type} question fields are invalid`);
  }
  return type;
};

export const validateQuestionCheckpoint = (questions, job = {}) => {
  if (!Array.isArray(questions) || questions.length > 200) throw new Error('Generation questions must be an array of at most 200 items');
  const strict = Boolean(job.options?.ragProfile || job.options?.promptProfileSnapshot || job.options?.resolvedSettings);
  const allowedDocumentIds = new Set(Array.isArray(job.documentIds) ? job.documentIds : []);
  const expected = strict ? expectedCounts(job.options) : undefined;
  const questionCount = job.options?.questionCount
    ?? Object.values(expected ?? {}).reduce((sum, count) => sum + count, 0);
  const counts = { 'multiple-choice': 0, 'fill-blank': 0, reasoning: 0, coding: 0 };
  const coverageSlots = new Set();
  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question) || !boundedText(question.statement, 1, 20_000)) {
      throw new Error('Generation checkpoint contains an invalid question');
    }
    if (!strict) continue;
    const type = validateStrictQuestion(question, job.options);
    counts[type] += 1;
    validateProvenance(question.provenance, allowedDocumentIds, questionCount);
    if (question.provenance.coverageSlot !== undefined) {
      const range = coverageRange(type, expected);
      if (question.provenance.coverageSlot < range.start || question.provenance.coverageSlot >= range.end) {
        throw new Error('Question provenance coverage slot does not match its question type');
      }
      if (coverageSlots.has(question.provenance.coverageSlot)) throw new Error('Question provenance coverage slots must be unique');
      coverageSlots.add(question.provenance.coverageSlot);
    }
  }
  if (strict) {
    for (const type of questionTypes) {
      if (!Number.isSafeInteger(expected[type]) || expected[type] < 0 || expected[type] > 200) {
        throw new Error('Generation job has invalid expected question counts');
      }
      if (counts[type] > expected[type]) throw new Error(`Generation checkpoint exceeds the ${type} question target`);
    }
  }
  return questions;
};
