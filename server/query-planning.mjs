/** Maximum character length for a query sent to sparse or dense retrieval. */
export const MAX_VARIANT_LENGTH = 256;

/** Maximum number of deterministic query variants, excluding an optional HyDE passage. */
export const MAX_VARIANTS = 4;

const searchableTokens = value => String(value).match(/[\p{L}\p{N}_-]+/gu) ?? [];
const noiseWords = new Set([
  'a', 'about', 'an', 'and', 'are', 'for', 'how', 'in', 'is', 'of', 'or', 'the', 'to', 'versus', 'vs', 'what', 'when', 'where', 'who', 'why', 'with',
  'các', 'cho', 'của', 'đâu', 'gì', 'hay', 'hoặc', 'khi', 'là', 'nào', 'như', 'những', 'ở', 'sao', 'thế', 'thì', 'tại', 'trong', 'và', 'về', 'với',
]);
const separator = /\s+(?:and|or|versus|vs\.?|and\/or|và|hoặc|hay|với)\s+|[,;]+/giu;

const addUnique = (variants, seen, value) => {
  const normalized = normalizeQuery(value);
  const key = normalized.toLocaleLowerCase();
  if (normalized.length < 2 || seen.has(key) || variants.length >= MAX_VARIANTS) return;
  seen.add(key);
  variants.push(normalized);
};

export const normalizeQuery = query => {
  if (typeof query !== 'string') return '';
  const normalized = query.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return [...normalized].slice(0, MAX_VARIANT_LENGTH).join('');
};

export const condenseQuery = query => {
  const normalized = normalizeQuery(query);
  if (!normalized) return '';
  const condensed = searchableTokens(normalized)
    .filter(token => !noiseWords.has(token.toLocaleLowerCase()))
    .join(' ');
  return normalizeQuery(condensed || normalized);
};

/**
 * Produces deterministic, bounded bilingual search variants without invoking a model.
 * The original query remains first, followed by its condensed form and independent
 * concepts split on common English and Vietnamese conjunctions.
 */
export const decomposeQuery = query => {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const variants = [];
  const seen = new Set();
  addUnique(variants, seen, normalized);
  addUnique(variants, seen, condenseQuery(normalized));
  for (const part of normalized.split(separator)) addUnique(variants, seen, condenseQuery(part));
  return variants;
};
