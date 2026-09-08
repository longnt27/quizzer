import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { seaLanceDbPlugin } from '../scripts/sea-lancedb-plugin.mjs';

const projectDirectory = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

const lanceDbTarget = process.platform === 'darwin'
  ? `@lancedb/lancedb-darwin-${process.arch}`
  : process.platform === 'win32'
    ? `@lancedb/lancedb-win32-${process.arch}-msvc`
    : `@lancedb/lancedb-linux-${process.arch}-gnu`;

test('SEA bundling replaces LanceDB platform probing with the host-addon shim', async () => {
  const result = await build({
    entryPoints: [resolve(projectDirectory, 'server', 'dense-index.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: `node${process.versions.node.split('.')[0]}`,
    write: false,
    metafile: true,
    plugins: [seaLanceDbPlugin(projectDirectory)],
  });

  const inputs = Object.keys(result.metafile.inputs).map(path => path.replaceAll('\\', '/'));
  assert.ok(inputs.some(path => path.endsWith('scripts/sea-lancedb-native.cjs')));
  assert.ok(!inputs.some(path => path.endsWith('@lancedb/lancedb/dist/native.js')));
  assert.ok(!inputs.some(path => path.endsWith('.node')));
});

test('SEA LanceDB shim loads the selected N-API addon directly', () => {
  const packageEntry = require.resolve(lanceDbTarget);
  const packageDirectory = dirname(packageEntry);
  const addonName = process.platform === 'darwin'
    ? `lancedb.${process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'}.node`
    : process.platform === 'win32'
      ? `lancedb.win32-${process.arch}-msvc.node`
      : `lancedb.linux-${process.arch}-gnu.node`;
  const previous = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = resolve(packageDirectory, addonName);
  try {
    const binding = require('../scripts/sea-lancedb-native.cjs');
    assert.equal(typeof binding.Connection, 'function');
  } finally {
    if (previous === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previous;
  }
});
