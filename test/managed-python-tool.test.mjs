import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { installManagedPythonTool, managedPythonToolPaths } from '../server/managed-python-tool.mjs';

const toolRoot = join('/tmp', 'quizzer-tools', 'docling');

test('installs an exact pinned package into an isolated managed environment', async () => {
  const paths = managedPythonToolPaths(toolRoot, 'docling');
  const commands = [];
  const checks = [];
  const progress = [];

  const result = await installManagedPythonTool({
    directory: toolRoot,
    executableName: 'docling',
    packageSpec: 'docling==2.126.0',
    resolvePython: async () => '/usr/bin/python3',
    runCommand: async (command, args, options) => {
      commands.push({ command, args, timeout: options?.timeout });
      return '';
    },
    commandWorks: async (command, args, timeout) => {
      checks.push({ command, args, timeout });
      return true;
    },
    onProgress: message => progress.push(message),
  });

  assert.equal(result.executable, paths.executable);
  assert.equal(result.packageSpec, 'docling==2.126.0');
  assert.deepEqual(commands[0], {
    command: '/usr/bin/python3', args: ['-m', 'venv', toolRoot], timeout: 120_000,
  });
  assert.deepEqual(commands[1], {
    command: paths.pip,
    args: ['install', '--disable-pip-version-check', 'docling==2.126.0'],
    timeout: 30 * 60_000,
  });
  assert.equal(commands.some(call => call.args.includes('--upgrade')), false);
  assert.deepEqual(checks, [{ command: paths.executable, args: ['--version'], timeout: 60_000 }]);
  assert.match(progress.join('\n'), /private Python environment/i);
  assert.match(progress.join('\n'), /docling==2\.126\.0/i);
});

test('supports a Python launcher with required prefix arguments', async () => {
  const commands = [];
  await installManagedPythonTool({
    directory: toolRoot,
    executableName: 'docling',
    packageSpec: 'docling==2.126.0',
    resolvePython: async () => ({ command: 'py', prefix: ['-3'] }),
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return '';
    },
    commandWorks: async () => true,
  });
  assert.deepEqual(commands[0], {
    command: 'py',
    args: ['-3', '-m', 'venv', toolRoot],
  });
});

test('supports a tool-specific bounded startup check', async () => {
  const paths = managedPythonToolPaths(toolRoot, 'marker_single');
  const checks = [];
  await installManagedPythonTool({
    directory: toolRoot,
    executableName: 'marker_single',
    packageSpec: 'marker-pdf==2.0.0',
    healthArgs: ['--help'],
    resolvePython: async () => '/usr/bin/python3',
    runCommand: async () => '',
    commandWorks: async (command, args, timeout) => {
      checks.push({ command, args, timeout });
      return true;
    },
  });
  assert.deepEqual(checks, [{ command: paths.executable, args: ['--help'], timeout: 60_000 }]);
});

test('rejects a managed installation that cannot start its executable', async () => {
  await assert.rejects(installManagedPythonTool({
    directory: toolRoot,
    executableName: 'docling',
    packageSpec: 'docling==2.126.0',
    resolvePython: async () => '/usr/bin/python3',
    runCommand: async () => '',
    commandWorks: async () => false,
  }), /installed but failed its startup check/i);
});
