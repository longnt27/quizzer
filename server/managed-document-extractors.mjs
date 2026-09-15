import { join } from 'node:path';
import { DOCLING_PACKAGE_SPEC } from './docling-extraction.mjs';
import { installManagedPythonTool, managedPythonToolPaths } from './managed-python-tool.mjs';

export const MARKER_VERSION = '2.0.0';
export const MARKER_PACKAGE_SPEC = `marker-pdf==${MARKER_VERSION}`;

export const installManagedMarker = ({
  directory,
  installTool = installManagedPythonTool,
  resolvePython,
  runCommand,
  commandWorks,
  onProgress = () => undefined,
} = {}) => installTool({
  directory,
  executableName: 'marker_single',
  packageSpec: MARKER_PACKAGE_SPEC,
  healthArgs: ['--help'],
  resolvePython,
  runCommand,
  commandWorks,
  onProgress,
});

export const installManagedDocling = async ({
  directory,
  installTool = installManagedPythonTool,
  resolvePython,
  runCommand,
  commandWorks,
  onProgress = () => undefined,
} = {}) => {
  const installed = await installTool({
    directory,
    executableName: 'docling',
    packageSpec: DOCLING_PACKAGE_SPEC,
    healthArgs: ['--version'],
    resolvePython,
    runCommand,
    commandWorks,
    onProgress,
  });
  const tools = managedPythonToolPaths(directory, 'docling-tools');
  const artifactsPath = join(directory, 'artifacts');
  onProgress('Downloading Docling models into Quizzer’s private environment…');
  await runCommand(tools.executable, ['models', 'download', '-o', artifactsPath], {
    timeout: 30 * 60_000,
    onOutput: output => { if (output) onProgress(output); },
  });
  return { ...installed, artifactsPath };
};
