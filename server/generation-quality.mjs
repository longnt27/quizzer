const CONTROL_TERMS = new Set([
  'about', 'advanced', 'answer', 'answers', 'beginner', 'coding', 'compare', 'create', 'difficult',
  'easy', 'explain', 'focus', 'focused', 'generate', 'hard', 'include', 'instruction', 'make',
  'only', 'question', 'questions', 'quiz', 'regarding', 'test', 'tests', 'use', 'using',
  'cau', 'chi', 'de', 'dung', 'hoi', 'kho', 'tao', 'tap', 'trung', 've',
]);

const COMMON_TERMS = new Set([
  'and', 'are', 'but', 'can', 'does', 'for', 'from', 'has', 'have', 'how', 'into', 'its', 'not',
  'that', 'the', 'their', 'then', 'these', 'this', 'those', 'was', 'what', 'when', 'where',
  'which', 'why', 'with', 'would', 'cua', 'cho', 'khi', 'mot', 'nhung', 'theo', 'thi', 'tren',
  'trong', 'voi',
]);

const stem = term => {
  if (term.length <= 4) return term;
  if (term.endsWith('ies') && term.length > 5) return `${term.slice(0, -3)}y`;
  for (const suffix of ['ments', 'ment', 'ingly', 'edly', 'ing', 'ed', 's']) {
    if (term.endsWith(suffix) && term.length - suffix.length >= 4) return term.slice(0, -suffix.length);
  }
  return term;
};

export const qualityTerms = value => new Set(
  (value === undefined || value === null ? []
    : String(value).normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .map(stem)
    .filter(term => term.length >= 3 && !COMMON_TERMS.has(term)),
);

const answerEvidence = question => {
  if (question.type === 'multiple-choice') {
    return question.answer?.filter(answer => answer?.correct)
      .flatMap(answer => [answer.content, answer.explanation]) ?? [];
  }
  if (question.type === 'fill-blank') return [...(question.acceptedAnswers ?? []), question.explanation];
  return [question.referenceAnswer, question.explanation];
};

const evidenceText = evidence => (evidence ?? []).flatMap(item => [
  item?.breadcrumb, item?.content, item?.parentContent,
  ...(item?.neighbors ?? []).map(neighbor => neighbor?.content),
]).filter(Boolean).join('\n');

const intersection = (left, right) => [...left].filter(term => right.has(term));

export const instructionTopicTerms = value => {
  if (typeof value !== 'string') return new Set();
  const subjects = [];
  for (const pattern of [
    /(?:about|regarding|focus(?:ed)?\s+on)\s+([^.;\n]+)/giu,
    /(?:về|tập\s+trung\s+vào)\s+([^.;\n]+)/giu,
    /([\p{L}\p{N}_.-]+(?:\s+[\p{L}\p{N}_.-]+){0,3})\s+(?:only|chỉ)\b/giu,
  ]) {
    for (const match of value.matchAll(pattern)) subjects.push(match[1]);
  }
  return new Set([...qualityTerms(subjects.join(' '))].filter(term => !CONTROL_TERMS.has(term)));
};

export const assessQuestionQuality = (question, evidence, customInstruction) => {
  const candidateTerms = qualityTerms([question?.statement, ...answerEvidence(question ?? {})].filter(Boolean).join('\n'));
  const sourceTerms = qualityTerms(evidenceText(evidence));
  const sharedTerms = intersection(candidateTerms, sourceTerms);
  const groundingMinimum = Math.min(2, candidateTerms.size, sourceTerms.size);
  const groundingScore = candidateTerms.size ? sharedTerms.length / candidateTerms.size : 0;
  if (!groundingMinimum || sharedTerms.length < groundingMinimum) {
    return { accepted: false, reason: 'ungrounded', groundingScore, sharedTerms };
  }

  const instructionTerms = instructionTopicTerms(customInstruction);
  if (instructionTerms.size) {
    const relevantTerms = new Set([...candidateTerms, ...sourceTerms]);
    const instructionMatches = intersection(instructionTerms, relevantTerms);
    if (!instructionMatches.length) {
      return { accepted: false, reason: 'instruction-mismatch', groundingScore, sharedTerms, instructionMatches };
    }
    return { accepted: true, groundingScore, sharedTerms, instructionMatches };
  }
  return { accepted: true, groundingScore, sharedTerms, instructionMatches: [] };
};

export const retrievalNeedsCorrection = result => !Array.isArray(result?.results)
  || !result.results.length || result.confidence === 'low' || Boolean(result.refusal);
