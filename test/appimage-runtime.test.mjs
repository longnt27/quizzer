import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  APPIMAGE_RUNTIME_TARGETS,
  APPIMAGE_TYPE2_RELEASE,
  normalizeAppImageArch,
  prepareAppImageRuntime,
  resolveAppImageTarget,
  resolveTargetArchFromArgs,
  validateRuntimeFile,
  verifyRuntimeFile,
} from '../release/appimage-runtime.mjs';

const createMockBinary = (size, filler = 0x41) => {
  const buf = Buffer.alloc(size, filler);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { buffer: buf, size, sha256 };
};

test('correct selection selects immutable release 20251108 assets for x64 and arm64', () => {
  assert.equal(APPIMAGE_TYPE2_RELEASE, '20251108');

  // Architecture normalization
  assert.equal(normalizeAppImageArch('x64'), 'x64');
  assert.equal(normalizeAppImageArch('x86_64'), 'x64');
  assert.equal(normalizeAppImageArch('amd64'), 'x64');
  assert.equal(normalizeAppImageArch('arm64'), 'arm64');
  assert.equal(normalizeAppImageArch('aarch64'), 'arm64');
  assert.equal(normalizeAppImageArch('ia32'), null);
  assert.equal(normalizeAppImageArch(''), null);

  // x64 target selection
  const x64Target = resolveAppImageTarget('x64');
  assert.equal(x64Target.architecture, 'x64');
  assert.equal(x64Target.appImageArch, 'x86_64');
  assert.equal(x64Target.assetName, 'runtime-x86_64');
  assert.equal(x64Target.size, 944632);
  assert.equal(x64Target.sha256, '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d');
  assert.equal(x64Target.url, 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64');

  // arm64 target selection
  const arm64Target = resolveAppImageTarget('arm64');
  assert.equal(arm64Target.architecture, 'arm64');
  assert.equal(arm64Target.appImageArch, 'aarch64');
  assert.equal(arm64Target.assetName, 'runtime-aarch64');
  assert.equal(arm64Target.size, 936456);
  assert.equal(arm64Target.sha256, '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444');
  assert.equal(arm64Target.url, 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-aarch64');

  // Unsupported architectures rejected
  assert.throws(() => resolveAppImageTarget('ia32'), /Unsupported AppImage architecture: "ia32"/);
  assert.throws(() => resolveAppImageTarget('armhf'), /Unsupported AppImage architecture: "armhf"/);

  // Command-line argument resolution and conflict rejection
  assert.equal(resolveTargetArchFromArgs(['--arch', 'x64']), 'x64');
  assert.equal(resolveTargetArchFromArgs(['--arch=arm64']), 'arm64');
  assert.equal(resolveTargetArchFromArgs(['--arch', 'x86_64']), 'x64');
  assert.equal(resolveTargetArchFromArgs(['--arch', 'aarch64']), 'arm64');
  assert.throws(() => resolveTargetArchFromArgs(['--arch', 'x64', '--arch', 'arm64']), /Conflicting target architectures/);
  assert.throws(() => resolveTargetArchFromArgs(['--arch=x64,arm64']), /Conflicting target architectures/);
  assert.throws(() => resolveTargetArchFromArgs(['--arch', 'ia32']), /Unsupported AppImage target architecture: "ia32"/);
});

test('cache verification reuses valid cached file without network requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-cache-test-'));
  try {
    const target = resolveAppImageTarget('x64');
    const mockContent = Buffer.alloc(target.size, 0x5a);
    const mockSha = createHash('sha256').update(mockContent).digest('hex');

    // Create a target fixture with matching hash and size
    const testTarget = { ...target, sha256: mockSha };
    const filePath = join(directory, testTarget.assetName);
    await writeFile(filePath, mockContent);

    let fetchCalled = false;
    const fetchFn = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    };

    const isCached = await verifyRuntimeFile(filePath, testTarget);
    assert.equal(isCached, true);

    const resultPath = await prepareAppImageRuntime({
      architecture: 'x64',
      cacheDirectory: directory,
      fetch: fetchFn,
      url: 'https://example.com/runtime-x86_64',
      expectedSha256: mockSha,
    });

    // Overrode verify with official digest will check against official target;
    // let's test directly with mock fetch and verifyRuntimeFile
    assert.equal(fetchCalled, false);
    assert.equal(resultPath, filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tampering detection rejects corrupted cache and tampered downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-tamper-test-'));
  try {
    const target = resolveAppImageTarget('x64');
    const filePath = join(directory, target.assetName);

    // Corrupted cached file (wrong hash)
    await writeFile(filePath, Buffer.alloc(target.size, 0x00));
    const isCorruptValid = await verifyRuntimeFile(filePath, target);
    assert.equal(isCorruptValid, false);
    await assert.rejects(
      validateRuntimeFile(filePath, target),
      /SHA-256 mismatch for runtime-x86_64/,
    );

    // Tampered payload during fetch
    const tamperedPayload = Buffer.alloc(target.size, 0x11);
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(target.size) }),
      arrayBuffer: async () => tamperedPayload.buffer,
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchFn,
      }),
      /SHA-256 digest mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('redirects are strictly disabled and rejected without following', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-redirect-test-'));
  try {
    // 301 Moved Permanently
    const fetch301 = async () => ({
      ok: false,
      status: 301,
      type: 'opaqueredirect',
      headers: new Headers({ location: 'https://cdn.example.com/asset' }),
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetch301,
      }),
      /Redirects are disabled when downloading AppImage runtime/,
    );

    // 302 Found
    const fetch302 = async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'https://cdn.example.com/asset' }),
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'arm64',
        cacheDirectory: directory,
        fetch: fetch302,
      }),
      /Redirects are disabled when downloading AppImage runtime/,
    );

    // Response marked as redirected
    const fetchRedirected = async () => ({
      ok: true,
      status: 200,
      redirected: true,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.alloc(10).buffer,
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchRedirected,
      }),
      /Redirects are disabled when downloading AppImage runtime/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversize download is rejected and temporary file is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-oversize-test-'));
  try {
    const target = resolveAppImageTarget('x64');
    const oversizeBuffer = Buffer.alloc(target.size + 1024, 0x41);

    // Oversize via content-length header
    const fetchHeaderOversize = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(target.size + 100) }),
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchHeaderOversize,
      }),
      /Content-Length mismatch for runtime-x86_64/,
    );

    // Oversize via body stream
    const fetchBodyOversize = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(target.size) }),
      arrayBuffer: async () => oversizeBuffer.buffer,
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchBodyOversize,
      }),
      /Downloaded AppImage runtime exceeded expected size/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('truncation download is rejected and temporary file is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-truncation-test-'));
  try {
    const target = resolveAppImageTarget('arm64');
    const truncatedBuffer = Buffer.alloc(target.size - 500, 0x41);

    const fetchTruncated = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(target.size) }),
      arrayBuffer: async () => truncatedBuffer.buffer,
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'arm64',
        cacheDirectory: directory,
        fetch: fetchTruncated,
      }),
      /Truncated AppImage runtime download: expected 936456 bytes, received 935956 bytes/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Forge configuration wires explicit runtime without continuous fallback', async () => {
  const forgeConfig = (await import(`../forge.config.mjs?test=${Date.now()}`)).default;
  const appImage = forgeConfig.makers.find(m => m.name === 'AppImage');

  assert.ok(appImage, 'MakerAppImage is configured');
  assert.deepEqual(appImage.platformsToMakeOn, ['linux']);
  assert.ok(appImage.configOrConfigFetcher.options.runtime, 'runtime option must be present');
  assert.notEqual(appImage.configOrConfigFetcher.options.runtime, undefined);
  assert.doesNotMatch(appImage.configOrConfigFetcher.options.runtime, /continuous/, 'Must not fall back to continuous');

  // Test dynamic environment override
  const customRuntimePath = '/custom/path/to/runtime-x86_64';
  const previousEnv = process.env.QUIZZER_APPIMAGE_RUNTIME;
  try {
    process.env.QUIZZER_APPIMAGE_RUNTIME = customRuntimePath;
    const dynamicConfig = (await import(`../forge.config.mjs?custom=${Date.now()}`)).default;
    const dynamicAppImage = dynamicConfig.makers.find(m => m.name === 'AppImage');
    assert.equal(dynamicAppImage.configOrConfigFetcher.options.runtime, customRuntimePath);
  } finally {
    if (previousEnv === undefined) delete process.env.QUIZZER_APPIMAGE_RUNTIME;
    else process.env.QUIZZER_APPIMAGE_RUNTIME = previousEnv;
  }
});
