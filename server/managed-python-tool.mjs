import { join } from 'node:path';

const boundedLabel = value => typeof value === 'string' && value.trim() && value.length <= 200;
const exactPackageSpecPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}==[0-9][A-Za-z0-9._+-]{0,63}$/;

export const managedPythonToolPaths = (directory, executableName, platform = process.platform) => {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Managed tool directory is required');
  if (!boundedLabel(executableName) || !/^[A-Za-z0-9._-]+$/.test(executableName)) {
    throw new Error('Managed tool executable name is invalid');
  }
  const binDirectory = join(directory, platform === 'win32' ? 'Scripts' : 'bin');
  return {
    python: join(binDirectory, platform === 'win32' ? 'python.exe' : 'python'),
    pip: join(binDirectory, platform === 'win32' ? 'pip.exe' : 'pip'),
    executable: join(binDirectory, platform === 'win32' ? `${executableName}.exe` : executableName),
  };
};

const normalizePythonLauncher = value => {
  if (typeof value === 'string' && value.trim()) return { command: value.trim(), prefix: [] };
  if (value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.command === 'string' && value.command.trim()
    && Array.isArray(value.prefix)
    && value.prefix.every(item => typeof item === 'string' && item.length <= 200)) {
    return { command: value.command.trim(), prefix: [...value.prefix] };
  }
  throw new Error('A compatible Python runtime is required');
};

export const installManagedPythonTool = async ({
  directory,
  executableName,
  packageSpec,
  healthArgs = ['--version'],
  resolvePython,
  runCommand,
  commandWorks,
  onProgress = () => undefined,
} = {}) => {
  if (!exactPackageSpecPattern.test(packageSpec ?? '')) {
    throw new Error('Managed Python tools must use an exact pinned package version');
  }
  if (!Array.isArray(healthArgs) || !healthArgs.length
    || healthArgs.some(value => typeof value !== 'string' || !value || value.length > 200)) {
    throw new Error('Managed Python tool health arguments are invalid');
  }
  if (typeof resolvePython !== 'function' || typeof runCommand !== 'function' || typeof commandWorks !== 'function') {
    throw new Error('Managed Python tool installer dependencies are incomplete');
  }
  if (typeof onProgress !== 'function') throw new Error('Managed Python tool progress handler is invalid');

  const paths = managedPythonToolPaths(directory, executableName);
  const python = normalizePythonLauncher(await resolvePython());

  onProgress('Creating Quizzer’s private Python environment…');
  await runCommand(python.command, [...python.prefix, '-m', 'venv', directory], {
    timeout: 120_000,
    onOutput: output => { if (output) onProgress(output); },
  });

  onProgress(`Installing ${packageSpec} in Quizzer’s private environment…`);
  await runCommand(paths.pip, ['install', '--disable-pip-version-check', packageSpec], {
    timeout: 30 * 60_000,
    onOutput: output => { if (output) onProgress(output); },
  });

  const ready = await commandWorks(paths.executable, healthArgs, 60_000);
  if (!ready) throw new Error(`${executableName} installed but failed its startup check.`);

  return { ...paths, packageSpec };
};
