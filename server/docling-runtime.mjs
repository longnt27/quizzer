import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedPythonToolPaths } from './managed-python-tool.mjs';
import { defaultAppDataDirectory } from './paths.mjs';
import { materializeRuntimeAsset, runningAsSingleExecutable } from './runtime-assets.mjs';

const BRIDGE_ASSET_KEY = 'scripts/docling_extract.py';

export const managedDoclingRuntimePaths = (appDataDirectory = defaultAppDataDirectory()) => {
  const directory = join(appDataDirectory, '.quizzer-tools', 'docling');
  const tool = managedPythonToolPaths(directory, 'docling');
  return {
    directory,
    python: tool.python,
    executable: tool.executable,
    artifactsPath: join(directory, 'artifacts'),
    managedBridgePath: join(directory, 'runtime', 'docling_extract.py'),
  };
};

export const loadManagedDoclingRuntime = async ({ appDataDirectory = defaultAppDataDirectory() } = {}) => {
  const paths = managedDoclingRuntimePaths(appDataDirectory);
  const scriptPath = runningAsSingleExecutable
    ? await materializeRuntimeAsset(BRIDGE_ASSET_KEY, paths.managedBridgePath)
    : fileURLToPath(new URL('../scripts/docling_extract.py', import.meta.url));
  try {
    await Promise.all([access(paths.python), access(paths.artifactsPath), access(scriptPath)]);
  } catch {
    throw Object.assign(new Error('Docling is not installed completely. Install it from Document settings first.'), {
      code: 'provider_unavailable',
    });
  }
  return { python: paths.python, scriptPath };
};
