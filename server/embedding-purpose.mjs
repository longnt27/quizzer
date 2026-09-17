const embed = (embedding, texts, purpose, signal) => {
  if (!embedding || typeof embedding.embed !== 'function') throw new Error('A resolved embedding route is required');
  return embedding.embed(texts, { purpose, signal });
};

export const embedDocumentTexts = (embedding, texts, signal) => embed(embedding, texts, 'document', signal);
export const embedQueryTexts = (embedding, texts, signal) => embed(embedding, texts, 'query', signal);
