import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const cli = new URL('../scripts/run-rag-lab.mjs', import.meta.url);
test('RAG lab help is offline and describes diagnostic modes', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(cli), '--help'], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /oracle/); assert.match(r.stdout, /synthesize/);
});
test('unknown flags fail before source or provider access', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(cli), 'benchmark', '--invented'], {encoding:'utf8'});
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Unknown option/);
});
test('invalid modes fail without loading production dependencies', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(cli), 'benchmark', '--mode', 'pretend', '--out', '/tmp/unused-rag-result.json'], {encoding:'utf8'});
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Invalid mode/);
});
