import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/ocr-plugin-registry.yml', import.meta.url);

const includesAll = (source, values) => {
  for (const value of values) assert.match(source, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
};

test('OCR plugin workflow builds pinned self-contained Tesseract runtimes on every supported target', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  includesAll(workflow, [
    'ubuntu-24.04',
    'ubuntu-24.04-arm',
    'macos-15-intel',
    'macos-15',
    'windows-2022',
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'db0ec62f81b0737fbbe184d8fea40af5738f8eef',
    '9e44ec0e9f247d77c230ced0ee66c76296837807',
    '87416418657359cb625c412a48b6e1d6d41c29bd',
    'BUILD_SHARED_LIBS=OFF',
    'BUILD_TRAINING_TOOLS=OFF',
    'GRAPHICS_DISABLED=ON',
    'OPENMP_BUILD=OFF',
    'DISABLE_ARCHIVE=ON',
    'DISABLE_CURL=ON',
    'phototest.tif',
    '--tessdata-dir',
  ]);
  assert.doesNotMatch(workflow, /win32-arm64/);
  assert.match(workflow, /ldd .*tesseract/);
  assert.match(workflow, /otool -L .*tesseract/);
  assert.match(workflow, /dumpbin \/DEPENDENTS/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(
    workflow,
    /name: Upload portable Tesseract runtime[\s\S]*?path: bundle\/vendor\n/,
    'native artifacts must retain their target directory so merge-multiple can assemble vendor/<target>/...',
  );
});

test('OCR plugin workflow assembles the exact bundle, signs it, and gates publication', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /merge-multiple: true/);
  assert.match(workflow, /tessdata\/eng\.traineddata/);
  assert.match(workflow, /licenses\/Tesseract-LICENSE/);
  assert.match(workflow, /licenses\/Leptonica-LICENSE/);
  assert.match(workflow, /licenses\/tessdata_fast-LICENSE/);
  assert.match(workflow, /QUIZZER_TESSERACT_BUNDLE_DIRECTORY/);
  assert.match(workflow, /scripts\/build-ocr-plugin-registry\.mjs/);
  assert.match(workflow, /environment: release/);
  assert.match(workflow, /inputs\.publish == true/);
  assert.match(workflow, /QUIZZER_PLUGIN_REGISTRY_PRIVATE_KEY/);
  assert.match(workflow, /gh release (?:create|upload)/);
});
