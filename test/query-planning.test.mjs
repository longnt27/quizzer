import assert from 'node:assert/strict';
import test from 'node:test';
import {
  condenseQuery,
  decomposeQuery,
  MAX_VARIANT_LENGTH,
  MAX_VARIANTS,
  normalizeQuery,
} from '../server/query-planning.mjs';

test('normalizes Unicode and whitespace within a hard length bound', () => {
  assert.equal(normalizeQuery('  Ｄｏｃｋｅｒ \t state \n'), 'Docker state');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery('x'.repeat(1_000)).length, MAX_VARIANT_LENGTH);
});

test('condenses English and Vietnamese filler without producing an empty query', () => {
  assert.equal(condenseQuery('What is the difference between Docker and Podman?'), 'difference between Docker Podman');
  assert.equal(condenseQuery('Các thành phần là gì và ở đâu?'), 'thành phần');
  assert.equal(condenseQuery('what is the'), 'what is the');
});

test('decomposes English queries deterministically with unique bounded variants', () => {
  const query = 'difference between Docker and Podman';
  const variants = decomposeQuery(query);
  assert.deepEqual(variants, [
    'difference between Docker and Podman',
    'difference between Docker Podman',
    'difference between Docker',
    'Podman',
  ]);
  assert.deepEqual(decomposeQuery(query), variants);
  assert.equal(new Set(variants.map(value => value.toLocaleLowerCase())).size, variants.length);
  assert.ok(variants.every(value => value.length <= MAX_VARIANT_LENGTH));
});

test('decomposes Vietnamese queries and caps downstream work', () => {
  assert.deepEqual(decomposeQuery('phân biệt Docker và Podman'), [
    'phân biệt Docker và Podman',
    'phân biệt Docker Podman',
    'phân biệt Docker',
    'Podman',
  ]);
  const variants = decomposeQuery('apple and banana and cherry and date and elderberry');
  assert.equal(variants.length, MAX_VARIANTS);
  assert.deepEqual(decomposeQuery(''), []);
});
