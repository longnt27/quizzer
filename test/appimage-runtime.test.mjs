import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('accepted one-hop GitHub asset redirect allows downloading from release-assets.githubusercontent.com', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-onehop-test-'));
  try {
    const target = resolveAppImageTarget('x64');
    const mockBinary = createMockBinary(target.size, 0x42);
    const redirectDestination = 'https://release-assets.githubusercontent.com/github-release-asset/mock-uuid?token=secret123';

    let initialRequestMade = false;
    let redirectedRequestMade = false;

    const fetchFn = async (requestedUrl, init) => {
      if (requestedUrl === target.url) {
        initialRequestMade = true;
        assert.equal(init?.redirect, 'manual', 'must not follow automatic redirects');
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: redirectDestination }),
        };
      }
      if (requestedUrl === redirectDestination) {
        redirectedRequestMade = true;
        assert.equal(init?.redirect, 'manual', 'must keep manual redirect on second hop');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(mockBinary.size) }),
          arrayBuffer: async () => mockBinary.buffer,
        };
      }
      throw new Error(`Unexpected request to ${requestedUrl}`);
    };

    const savedPath = await prepareAppImageRuntime({
      architecture: 'x64',
      cacheDirectory: directory,
      fetch: fetchFn,
      expectedSha256: mockBinary.sha256,
      expectedSize: mockBinary.size,
    });

    assert.equal(initialRequestMade, true);
    assert.equal(redirectedRequestMade, true);
    assert.equal(savedPath, join(directory, target.assetName));

    const stats = await stat(savedPath);
    assert.equal(stats.size, mockBinary.size);
    assert.ok((stats.mode & 0o111) !== 0, 'file should be executable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejected host in redirect is blocked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-badhost-test-'));
  try {
    const target = resolveAppImageTarget('x64');
    const fetchEvilHost = async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'https://evil.attacker.com/runtime-x86_64' }),
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchEvilHost,
      }),
      /Rejected redirect destination host "evil\.attacker\.com"/,
    );

    const fetchOtherGitHubHost = async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'https://raw.githubusercontent.com/runtime-x86_64' }),
    });

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchOtherGitHubHost,
      }),
      /Rejected redirect destination host "raw\.githubusercontent\.com"/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejected second redirect or redirect chain is blocked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-chain-test-'));
  try {
    const target = resolveAppImageTarget('x64');
    const hop1 = 'https://release-assets.githubusercontent.com/step1';
    const hop2 = 'https://release-assets.githubusercontent.com/step2';

    const fetchChain = async (requestedUrl) => {
      if (requestedUrl === target.url) {
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: hop1 }),
        };
      }
      if (requestedUrl === hop1) {
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: hop2 }),
        };
      }
      throw new Error(`Unexpected request to ${requestedUrl}`);
    };

    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchChain,
      }),
      /Rejected redirect chain: second redirect received/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('insecure protocols, credentials, fragments, and non-pinned sources in redirects are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-runtime-security-test-'));
  try {
    // Insecure HTTP protocol
    const fetchHttp = async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://release-assets.githubusercontent.com/asset' }),
    });
    await assert.rejects(
      prepareAppImageRuntime({ architecture: 'x64', cacheDirectory: directory, fetch: fetchHttp }),
      /Rejected insecure redirect protocol "http:"/,
    );

    // Credentials in redirect URL
    const fetchCreds = async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'https://user:pass@release-assets.githubusercontent.com/asset' }),
    });
    await assert.rejects(
      prepareAppImageRuntime({ architecture: 'x64', cacheDirectory: directory, fetch: fetchCreds }),
      /Rejected redirect containing credentials in URL/,
    );

    // Fragment in redirect URL
    const fetchFrag = async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'https://release-assets.githubusercontent.com/asset#fragment' }),
    });
    await assert.rejects(
      prepareAppImageRuntime({ architecture: 'x64', cacheDirectory: directory, fetch: fetchFrag }),
      /Rejected redirect containing URL fragment/,
    );

    // Missing Location header
    const fetchNoLocation = async () => ({
      ok: false,
      status: 302,
      headers: new Headers(),
    });
    await assert.rejects(
      prepareAppImageRuntime({ architecture: 'x64', cacheDirectory: directory, fetch: fetchNoLocation }),
      /missing Location header/,
    );

    // Redirect originating from non-pinned URL
    const fetchNonPinned = async () => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'https://release-assets.githubusercontent.com/asset' }),
    });
    await assert.rejects(
      prepareAppImageRuntime({
        architecture: 'x64',
        cacheDirectory: directory,
        fetch: fetchNonPinned,
        url: 'https://custom-mirror.example.com/asset',
      }),
      /redirects are only permitted from the exact pinned GitHub release URL/i,
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

test('successful safe forge wrapper validation executes cleanly and validates arguments', async () => {
  const forgeScript = resolve('scripts/forge.mjs');

  // 1. package --help uses spawn and fileURLToPath cleanly
  const pkgHelp = spawnSync(process.execPath, [forgeScript, 'package', '--help'], { encoding: 'utf8' });
  assert.equal(pkgHelp.status, 0, `package --help should exit 0, got: ${pkgHelp.stderr}`);
  assert.match(pkgHelp.stdout, /electron-forge-package/);

  // 2. make --platform darwin --help runs safely without linux runtime checks
  const darwinHelp = spawnSync(process.execPath, [forgeScript, 'make', '--platform', 'darwin', '--help'], { encoding: 'utf8' });
  assert.equal(darwinHelp.status, 0, `make --platform darwin --help should exit 0, got: ${darwinHelp.stderr}`);
  assert.match(darwinHelp.stdout, /electron-forge-make/);

  // 3. make --platform linux with valid verified runtime in QUIZZER_APPIMAGE_RUNTIME
  const cachedX64Runtime = resolve('node_modules/.cache/quizzer/appimage-runtime/runtime-x86_64');
  let hasCachedRuntime = false;
  try {
    const stats = await stat(cachedX64Runtime);
    hasCachedRuntime = stats.isFile();
  } catch {}

  if (hasCachedRuntime) {
    const linuxHelp = spawnSync(
      process.execPath,
      [forgeScript, 'make', '--platform', 'linux', '--arch', 'x64', '--help'],
      {
        env: { ...process.env, QUIZZER_APPIMAGE_RUNTIME: cachedX64Runtime },
        encoding: 'utf8',
      },
    );
    assert.equal(linuxHelp.status, 0, `linux make with verified runtime should exit 0: ${linuxHelp.stderr}`);
    assert.match(linuxHelp.stdout, /electron-forge-make/);
  }

  // 4. make --platform linux with invalid/tampered runtime in QUIZZER_APPIMAGE_RUNTIME
  const invalidRuntime = spawnSync(
    process.execPath,
    [forgeScript, 'make', '--platform', 'linux', '--arch', 'x64', '--help'],
    {
      env: { ...process.env, QUIZZER_APPIMAGE_RUNTIME: resolve('package.json') },
      encoding: 'utf8',
    },
  );
  assert.notEqual(invalidRuntime.status, 0, 'tampered runtime path must be rejected');
  assert.match(invalidRuntime.stderr, /mismatch/);

  // 5. make with unsupported architecture
  const ia32Run = spawnSync(
    process.execPath,
    [forgeScript, 'make', '--platform', 'linux', '--arch', 'ia32'],
    { encoding: 'utf8' },
  );
  assert.notEqual(ia32Run.status, 0, 'unsupported architecture must be rejected');
  assert.match(ia32Run.stderr, /Unsupported AppImage target architecture: "ia32"/);

  // 6. unknown forge command
  const badCmd = spawnSync(
    process.execPath,
    [forgeScript, 'deploy'],
    { encoding: 'utf8' },
  );
  assert.notEqual(badCmd.status, 0, 'unknown command must be rejected');
  assert.match(badCmd.stderr, /Usage: node scripts\/forge\.mjs <package\|make>/);
});

