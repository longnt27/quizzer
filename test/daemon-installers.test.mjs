import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const shellTemplate = await readFile(new URL('../installers/install.sh.in', import.meta.url), 'utf8');
const powershellTemplate = await readFile(new URL('../installers/install.ps1.in', import.meta.url), 'utf8');
const runtimeFunction = powershellTemplate.match(/function Install-QuizzerRuntime\([^]*?\n\}/)?.[0];
assert.ok(runtimeFunction, 'Windows installer must expose its runtime replacement operation');

test('Unix upgrades atomically replace a live executable and restart the enabled service', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-daemon-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin with spaces');
  const mocks = join(directory, 'commands');
  const units = join(directory, 'units');
  await mkdir(bin);
  await mkdir(mocks);
  const installed = join(bin, 'quizzer');
  const download = join(directory, 'download');
  await copyFile('/bin/sleep', installed);
  if (process.platform === 'darwin') await execute('codesign', ['--force', '--sign', '-', installed]);
  const originalInode = (await stat(installed)).ino;
  const daemon = spawn(installed, ['60']);
  t.after(() => { if (daemon.exitCode === null) daemon.kill(); });
  const exited = once(daemon, 'exit');
  await once(daemon, 'spawn');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(daemon.exitCode, null, 'installed executable must be running');
  assert.equal(daemon.signalCode, null, 'installed executable must be running');
  await writeFile(download, '#!/bin/sh\nprintf "new-runtime"\n');
  const observed = join(directory, 'active-version');
  await writeFile(observed, 'old-runtime');
  await writeFile(join(mocks, 'systemctl'), `#!/bin/sh
set -eu
case "$*" in
  '--user daemon-reload'|'--user enable quizzer.service') ;;
  '--user restart quizzer.service')
    kill "$QUIZZER_TEST_DAEMON_PID"
    "$QUIZZER_TEST_RUNTIME" serve --port 8787 > "$QUIZZER_TEST_ACTIVE_VERSION"
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const functions = ['install_runtime', 'start_linux_service'].map(name => {
    const body = shellTemplate.match(new RegExp(`${name}\\(\\) \\{[^]*?\\n\\}`))?.[0];
    assert.ok(body, name);
    return body;
  }).join('\n');
  const script = join(directory, 'upgrade.sh');
  await writeFile(script, `set -eu\n${functions}\ninstall_runtime "$1" "$2"\nstart_linux_service "$2" "$3"\n`);
  await execute('sh', [script, download, installed, units], {
    env: {
      ...process.env, PATH: `${mocks}:${process.env.PATH}`,
      QUIZZER_TEST_DAEMON_PID: String(daemon.pid), QUIZZER_TEST_RUNTIME: installed,
      QUIZZER_TEST_ACTIVE_VERSION: observed,
    },
  });
  await exited;
  assert.notEqual((await stat(installed)).ino, originalInode);
  assert.equal(await readFile(observed, 'utf8'), 'new-runtime');
  assert.ok((await readFile(join(units, 'quizzer.service'), 'utf8')).includes(`ExecStart="${installed}" serve --port 8787`));
});

test('Windows replacement stops its task and process before touching the runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-windows-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'upgrade.ps1');
  await writeFile(script, `$ErrorActionPreference = 'Stop'
function Fail([string] $Message) { throw $Message }
${runtimeFunction}
$script:TaskStopped = $false
$script:ProcessStopped = $false
$script:Waited = $false
function Get-ScheduledTask { [pscustomobject]@{ TaskName = 'Quizzer Local Service' } }
function Stop-ScheduledTask { $script:TaskStopped = $true }
function Get-Process {
  $process = [pscustomobject]@{ Path = 'installed.exe' }
  $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
    if (-not $script:ProcessStopped) { throw 'Process still owns executable' }
    $script:Waited = $true
    return $true
  }
  $process
}
function Stop-Process { $script:ProcessStopped = $true }
function Copy-Item {
  if (-not ($script:TaskStopped -and $script:ProcessStopped -and $script:Waited)) {
    throw 'Cannot overwrite the running executable'
  }
  'runtime-replaced'
}
Install-QuizzerRuntime 'download.exe' 'installed.exe' 'Quizzer Local Service'
# A service that cannot be stopped must leave the previous runtime intact.
function Stop-ScheduledTask { throw 'task-stop-failed' }
try {
  Install-QuizzerRuntime 'download.exe' 'installed.exe' 'Quizzer Local Service'
  throw 'Expected task stop failure'
} catch {
  if ($_.Exception.Message -ne 'task-stop-failed') { throw }
}
`);
  try {
    const result = await execute(process.env.QUIZZER_TEST_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-File', script]);
    assert.equal(result.stdout.trim(), 'runtime-replaced');
  } catch (error) {
    if (error.code === 'ENOENT' && process.platform !== 'win32') return t.skip('PowerShell is unavailable');
    throw error;
  }
});

test('Windows upgrades replace an executable locked by the actual daemon process', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-native-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'quizzer.exe');
  const download = join(directory, 'download.exe');
  await copyFile(process.execPath, installed);
  await writeFile(download, 'new-runtime');
  const daemon = spawn(installed, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)']);
  t.after(() => { if (daemon.exitCode === null) daemon.kill(); });
  const exited = once(daemon, 'exit');
  await once(daemon.stdout, 'data');
  const script = join(directory, 'upgrade.ps1');
  await writeFile(script, `param([string] $Download, [string] $Destination)
$ErrorActionPreference = 'Stop'
function Fail([string] $Message) { throw $Message }
${runtimeFunction}
function Get-ScheduledTask { [pscustomobject]@{ TaskName = 'Quizzer Local Service' } }
function Stop-ScheduledTask {}
Install-QuizzerRuntime $Download $Destination 'Quizzer Local Service'
`);
  await execute('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, download, installed]);
  await exited;
  assert.equal(await readFile(installed, 'utf8'), 'new-runtime');
});
