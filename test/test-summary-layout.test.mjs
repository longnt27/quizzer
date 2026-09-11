import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('history uses the Ant Design timeline connector instead of a panel-height border', async () => {
  const source = await readFile(new URL('../src/components/TestSummary.tsx', import.meta.url), 'utf8');
  const historyStart = source.indexOf('className="summary-history"');
  const historyEnd = source.indexOf('{/* JSON Fixer Modal */}', historyStart);
  assert.notEqual(historyStart, -1);
  assert.notEqual(historyEnd, -1);
  const history = source.slice(historyStart, historyEnd);
  assert.doesNotMatch(history, /borderLeft/);
  assert.match(history, /<Timeline className="summary-timeline"/);
});
