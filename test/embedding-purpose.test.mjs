import assert from 'node:assert/strict';
import test from 'node:test';
import { embedDocumentTexts, embedQueryTexts } from '../server/embedding-purpose.mjs';

test('marks dense index text as document embeddings', async () => {
  let options;
  const embedding = { embed: async (_texts, received) => { options = received; return [[1, 0]]; } };
  const signal = new AbortController().signal;
  assert.deepEqual(await embedDocumentTexts(embedding, ['chunk'], signal), [[1, 0]]);
  assert.deepEqual(options, { purpose: 'document', signal });
});

test('marks retrieval text as query embeddings', async () => {
  let options;
  const embedding = { embed: async (_texts, received) => { options = received; return [[0, 1]]; } };
  const signal = new AbortController().signal;
  assert.deepEqual(await embedQueryTexts(embedding, ['question'], signal), [[0, 1]]);
  assert.deepEqual(options, { purpose: 'query', signal });
});
