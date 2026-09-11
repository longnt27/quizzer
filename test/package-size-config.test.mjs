import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import forgeConfig from '../forge.config.mjs';

const browserOnly = [
  '@codemirror/lang-json', '@uiw/react-codemirror', 'antd', 'dexie', 'dexie-react-hooks',
  'react', 'react-dom', 'react-markdown', 'remark-gfm', 'uuid',
];

test('renderer libraries stay build-time only for desktop packaging', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of browserOnly) {
    assert.equal(pkg.dependencies?.[name], undefined, `${name} must not ship as a production Node dependency`);
    assert.ok(pkg.devDependencies?.[name], `${name} must remain available to Vite at build time`);
  }
  assert.equal(pkg.dependencies?.['@google/generative-ai'], undefined, 'unused Google SDK must not be packaged');
});

test('glibc desktop packages exclude duplicate musl native payloads', () => {
  const ignored = path => forgeConfig.packagerConfig.ignore.some(pattern => pattern.test(path));
  assert.equal(ignored('/node_modules/@lancedb/lancedb-linux-x64-musl/index.node'), true);
  assert.equal(ignored('/node_modules/@napi-rs/canvas-linux-x64-musl/skia.linux-x64-musl.node'), true);
  assert.equal(ignored('/node_modules/@lancedb/lancedb-linux-x64-gnu/index.node'), false);
});
