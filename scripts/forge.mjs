import { resolve } from 'node:path';
import {
  prepareAppImageRuntime,
  resolveAppImageTarget,
  resolveTargetArchFromArgs,
  validateRuntimeFile,
} from '../release/appimage-runtime.mjs';

const command = process.argv[2];
if (!['package', 'make'].includes(command)) {
  throw new Error('Usage: node scripts/forge.mjs <package|make>');
}

// Electron's bundled V8 defines the required C++ language level. A shell-level
// CXXFLAGS value can override it and make otherwise supported native addons fail.
const environment = { ...process.env };
delete environment.CXXFLAGS;

const extraArgs = process.argv.slice(3);
if (command === 'make') {
  let targetPlatform = process.platform;
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    if (arg === '--platform' && i + 1 < extraArgs.length) {
      targetPlatform = extraArgs[i + 1];
    } else if (arg.startsWith('--platform=')) {
      targetPlatform = arg.slice('--platform='.length);
    }
  }

  const platforms = targetPlatform.split(',').map(p => p.trim());
  if (platforms.includes('linux')) {
    const targetArch = resolveTargetArchFromArgs(extraArgs, process.arch);
    let runtimePath;
    if (environment.QUIZZER_APPIMAGE_RUNTIME) {
      runtimePath = resolve(environment.QUIZZER_APPIMAGE_RUNTIME);
      await validateRuntimeFile(runtimePath, resolveAppImageTarget(targetArch));
    } else {
      runtimePath = await prepareAppImageRuntime({ architecture: targetArch });
    }
    environment.QUIZZER_APPIMAGE_RUNTIME = runtimePath;
  }
}

const forgeCli = fileURLToPath(new URL('../node_modules/@electron-forge/cli/dist/electron-forge.js', import.meta.url));
const child = spawn(process.execPath, [forgeCli, command, ...extraArgs], {
  env: environment,
  stdio: 'inherit',
});

child.on('error', error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = typeof code === 'number' ? code : 1;
  if (signal) process.stderr.write(`Electron Forge stopped by ${signal}\n`);
});
