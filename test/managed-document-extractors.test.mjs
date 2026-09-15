import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  MARKER_PACKAGE_SPEC,
  installManagedDocling,
  installManagedMarker,
} from '../server/managed-document-extractors.mjs';
import { DOCLING_PACKAGE_SPEC } from '../server/docling-extraction.mjs';
import { managedPythonToolPaths } from '../server/managed-python-tool.mjs';

const root = join('/tmp', 'quizzer-tools');

const dependencies = () => {
  const installs = [];
  const commands = [];
  const progress = [];
  return {
    installs,
    commands,
    progress,
    resolvePython: async () => '/usr/bin/python3',
    commandWorks: async () => true,
    installTool: async options => {
      installs.push(options);
      const paths = managedPythonToolPaths(options.directory, options.executableName);
      return { ...paths, packageSpec: options.packageSpec };
    },
    runCommand: async (command, args, options) => {
      commands.push({ command, args, timeout: options?.timeout });
      return '';
    },
    onProgress: message => progress.push(message),
  };
};

test('pins Marker and reuses the shared managed Python installer', async () => {
  const deps = dependencies();
  const directory = join(root, 'marker');
  const result = await installManagedMarker({ directory, ...deps });

  assert.equal(MARKER_PACKAGE_SPEC, 'marker-pdf==2.0.0');
  assert.equal(result.packageSpec, MARKER_PACKAGE_SPEC);
  assert.equal(deps.installs.length, 1);
  assert.deepEqual({
    directory: deps.installs[0].directory,
    executableName: deps.installs[0].executableName,
    packageSpec: deps.installs[0].packageSpec,
    healthArgs: deps.installs[0].healthArgs,
  }, {
    directory,
    executableName: 'marker_single',
    packageSpec: MARKER_PACKAGE_SPEC,
    healthArgs: ['--help'],
  });
  assert.equal(deps.commands.length, 0);
});

test('pins Docling and prefetches its models into the private managed directory', async () => {
  const deps = dependencies();
  const directory = join(root, 'docling');
  const result = await installManagedDocling({ directory, ...deps });
  const tools = managedPythonToolPaths(directory, 'docling-tools');
  const artifactsPath = join(directory, 'artifacts');

  assert.equal(deps.installs.length, 1);
  assert.deepEqual({
    directory: deps.installs[0].directory,
    executableName: deps.installs[0].executableName,
    packageSpec: deps.installs[0].packageSpec,
    healthArgs: deps.installs[0].healthArgs,
  }, {
    directory,
    executableName: 'docling',
    packageSpec: DOCLING_PACKAGE_SPEC,
    healthArgs: ['--version'],
  });
  assert.deepEqual(deps.commands, [{
    command: tools.executable,
    args: ['models', 'download', '-o', artifactsPath],
    timeout: 30 * 60_000,
  }]);
  assert.equal(result.artifactsPath, artifactsPath);
  assert.match(deps.progress.join('\n'), /Downloading Docling models/i);
});
