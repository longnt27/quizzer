import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const APPIMAGE_TYPE2_RELEASE = '20251108';

export const APPIMAGE_RUNTIME_TARGETS = Object.freeze({
  x64: Object.freeze({
    architecture: 'x64',
    appImageArch: 'x86_64',
    assetName: 'runtime-x86_64',
    url: `https://github.com/AppImage/type2-runtime/releases/download/${APPIMAGE_TYPE2_RELEASE}/runtime-x86_64`,
    size: 944632,
    sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
  }),
  arm64: Object.freeze({
    architecture: 'arm64',
    appImageArch: 'aarch64',
    assetName: 'runtime-aarch64',
    url: `https://github.com/AppImage/type2-runtime/releases/download/${APPIMAGE_TYPE2_RELEASE}/runtime-aarch64`,
    size: 936456,
    sha256: '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444',
  }),
});

export const normalizeAppImageArch = arch => {
  if (typeof arch !== 'string') return null;
  const normalized = arch.trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') return 'x64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return null;
};

export const resolveAppImageTarget = architecture => {
  const normalized = normalizeAppImageArch(architecture);
  if (!normalized || !APPIMAGE_RUNTIME_TARGETS[normalized]) {
    throw new Error(`Unsupported AppImage architecture: "${architecture}". Supported architectures: x64, arm64`);
  }
  return APPIMAGE_RUNTIME_TARGETS[normalized];
};

export const resolveTargetArchFromArgs = (args = [], fallbackArch = process.arch) => {
  const architectures = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--arch') {
      if (i + 1 < args.length) {
        architectures.push(args[i + 1]);
        i++;
      }
    } else if (arg.startsWith('--arch=')) {
      architectures.push(arg.slice('--arch='.length));
    }
  }

  if (architectures.length === 0) {
    const normalizedFallback = normalizeAppImageArch(fallbackArch);
    if (!normalizedFallback) {
      throw new Error(`Unsupported host architecture for AppImage: "${fallbackArch}". Must specify --arch x64 or --arch arm64`);
    }
    return normalizedFallback;
  }

  const expanded = architectures.flatMap(a => a.split(',')).map(a => a.trim()).filter(Boolean);
  const normalized = expanded.map(a => {
    const norm = normalizeAppImageArch(a);
    if (!norm) throw new Error(`Unsupported AppImage target architecture: "${a}"`);
    return norm;
  });

  const unique = [...new Set(normalized)];
  if (unique.length > 1) {
    throw new Error(`Conflicting target architectures specified: ${unique.join(', ')}. AppImage packaging requires a single target architecture per run.`);
  }

  return unique[0];
};

export const verifyRuntimeFile = async (filePath, target) => {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  if (stats.size !== target.size) return false;

  const hasher = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  const actualHash = hasher.digest('hex');
  return actualHash === target.sha256;
};

export const validateRuntimeFile = async (filePath, target) => {
  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    throw new Error(`AppImage runtime file not found at ${filePath}: ${error.message}`);
  }
  if (!stats.isFile()) {
    throw new Error(`AppImage runtime path is not a regular file: ${filePath}`);
  }
  if (stats.size !== target.size) {
    throw new Error(`AppImage runtime size mismatch for ${target.assetName}: expected ${target.size} bytes, found ${stats.size} bytes`);
  }

  const hasher = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  const actualHash = hasher.digest('hex');
  if (actualHash !== target.sha256) {
    throw new Error(`AppImage runtime SHA-256 mismatch for ${target.assetName}: expected ${target.sha256}, got ${actualHash}`);
  }
  return true;
};

export const prepareAppImageRuntime = async (options = {}) => {
  const baseTarget = resolveAppImageTarget(options.architecture || process.arch);
  const target = {
    ...baseTarget,
    ...(typeof options.expectedSize === 'number' ? { size: options.expectedSize } : {}),
    ...(typeof options.expectedSha256 === 'string' ? { sha256: options.expectedSha256 } : {}),
  };
  const cacheDirectory = resolve(options.cacheDirectory || 'node_modules/.cache/quizzer/appimage-runtime');
  const targetPath = join(cacheDirectory, target.assetName);

  // 1. Re-verify a cached file before reuse
  try {
    const isCachedValid = await verifyRuntimeFile(targetPath, target);
    if (isCachedValid) {
      await chmod(targetPath, 0o755).catch(() => {});
      return targetPath;
    }
    // Remove invalid/corrupt cache file before re-downloading
    await rm(targetPath, { force: true }).catch(() => {});
  } catch {
    // Proceed to fetch if cache check fails
  }

  await mkdir(cacheDirectory, { recursive: true, mode: 0o755 });

  const fetchFn = options.fetch || globalThis.fetch;
  const url = options.url || target.url;
  const allowRedirects = options.allowRedirects === true;

  // 2. Disable redirects
  const response = await fetchFn(url, {
    redirect: allowRedirects ? 'follow' : 'manual',
    headers: { 'User-Agent': 'Quizzer-AppImage-Runtime-Preparer/1.0.0' },
  });

  if (!allowRedirects && ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect' || response.redirected)) {
    throw new Error(`Redirects are disabled when downloading AppImage runtime from ${url} (received status ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`Failed to download AppImage runtime from ${url}: HTTP ${response.status} ${response.statusText || ''}`.trim());
  }

  const contentLength = response.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) !== target.size) {
    throw new Error(`Content-Length mismatch for ${target.assetName}: expected ${target.size}, got ${contentLength}`);
  }

  // 3. Atomically cache the exact file, validate size and SHA-256
  const tempPath = join(cacheDirectory, `${target.assetName}.${process.pid}.${Date.now()}.tmp`);
  const hasher = createHash('sha256');
  let bytesReceived = 0;

  try {
    const fileHandle = await open(tempPath, 'w', 0o755);
    try {
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesReceived += value.byteLength;
          if (bytesReceived > target.size) {
            throw new Error(`Downloaded AppImage runtime exceeded expected size (${bytesReceived} > ${target.size})`);
          }
          hasher.update(value);
          await fileHandle.write(value);
        }
      } else {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        bytesReceived = buffer.length;
        if (bytesReceived > target.size) {
          throw new Error(`Downloaded AppImage runtime exceeded expected size (${bytesReceived} > ${target.size})`);
        }
        hasher.update(buffer);
        await fileHandle.write(buffer);
      }
    } finally {
      await fileHandle.close();
    }

    if (bytesReceived !== target.size) {
      throw new Error(`Truncated AppImage runtime download: expected ${target.size} bytes, received ${bytesReceived} bytes`);
    }

    const actualSha256 = hasher.digest('hex');
    if (actualSha256 !== target.sha256) {
      throw new Error(`AppImage runtime SHA-256 digest mismatch: expected ${target.sha256}, received ${actualSha256}`);
    }

    await rename(tempPath, targetPath);
    await chmod(targetPath, 0o755).catch(() => {});
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }

  // 4. Re-verify the cached file before returning
  await validateRuntimeFile(targetPath, target);
  return targetPath;
};
