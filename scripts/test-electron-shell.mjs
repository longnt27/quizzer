import { spawn } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { rebuild } from '@electron/rebuild';
import {
  isWindowsPlatform,
  packagedElectronExecutable,
  playwrightCommandForPlatform,
  spawnOptionsForPlatform,
  terminationPlanForPlatform,
} from './electron-shell-platform.mjs';

const projectDirectory = process.cwd();
const sqliteDirectory = join(projectDirectory, 'node_modules', 'better-sqlite3');
const electronPackage = JSON.parse(await readFile(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8'));

const findNativeArtifacts = async directory => {
  const artifacts = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) artifacts.push(...await findNativeArtifacts(path));
    else if (entry.isFile() && entry.name.endsWith('.node')) artifacts.push(path);
  }
  return artifacts;
};

const snapshotNativeArtifacts = async (directory, backupDirectory) => {
  const paths = await findNativeArtifacts(directory);
  if (!paths.length) throw new Error(`No native SQLite artifacts found under ${directory}`);
  const snapshot = [];
  for (const path of paths) {
    const destination = join(backupDirectory, relative(directory, path));
    const details = await stat(path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(path, destination, { force: true });
    await chmod(destination, details.mode & 0o7777);
    snapshot.push({ path, destination, mode: details.mode & 0o7777 });
  }
  return snapshot;
};

const restoreNativeArtifacts = async snapshot => {
  for (const artifact of snapshot) {
    const temporaryPath = `${artifact.path}.quizzer-restore-${process.pid}`;
    await copyFile(artifact.destination, temporaryPath);
    await chmod(temporaryPath, artifact.mode);
    try {
      await rename(temporaryPath, artifact.path);
    } catch (error) {
      // POSIX rename replaces the destination; Windows requires the existing
      // file to be removed first. The destination is an exact native artifact
      // captured immediately before this test, so this fallback is scoped.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      await rm(artifact.path, { force: true });
      await rename(temporaryPath, artifact.path);
    }
  }
};

const activeChildren = new Set();
const run = (command, args, environment = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: projectDirectory,
    stdio: 'inherit',
    env: environment,
    ...spawnOptionsForPlatform(process.platform),
  });
  activeChildren.add(child);
  const finish = (callback, value) => {
    activeChildren.delete(child);
    callback(value);
  };
  child.once('error', error => finish(reject, error));
  child.once('exit', code => finish(code === 0 ? resolve : reject,
    code === 0 ? undefined : new Error(`${command} ${args.join(' ')} exited with ${code ?? 'a signal'}`)));
});

const terminateChild = async (child, force) => {
  if (child.exitCode !== null || !child.pid) return;
  const plan = terminationPlanForPlatform({
    platform: process.platform,
    pid: child.pid,
    force,
    systemRoot: process.env.SystemRoot,
  });
  if (isWindowsPlatform(process.platform)) {
    await new Promise((resolve, reject) => {
      const killer = spawn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true });
      killer.once('error', reject);
      killer.once('exit', () => resolve());
    });
    return;
  }
  try {
    process.kill(plan.processGroup, plan.signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};

const waitForExit = (child, timeoutMs) => new Promise(resolve => {
  if (child.exitCode !== null) {
    resolve(true);
    return;
  }
  let timer;
  const onExit = () => {
    clearTimeout(timer);
    resolve(true);
  };
  timer = setTimeout(() => {
    child.off('exit', onExit);
    resolve(false);
  }, timeoutMs);
  child.once('exit', onExit);
});

const stopChildren = async () => {
  const children = [...activeChildren];
  await Promise.all(children.map(child => terminateChild(child, false)));
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null) return;
    if (await waitForExit(child, 5_000)) return;
    await terminateChild(child, true);
    if (!await waitForExit(child, 5_000)) throw new Error('A test subprocess did not exit after forceful termination');
  }));
};

const verifyNodeSqlite = () => run(process.execPath, ['--input-type=module', '--eval', [
  "import Database from 'better-sqlite3';",
  "const database = new Database(':memory:');",
  "database.exec('CREATE TABLE smoke (value TEXT NOT NULL)');",
  "database.prepare('INSERT INTO smoke VALUES (?)').run('ok');",
  "if (database.prepare('SELECT value FROM smoke').pluck().get() !== 'ok') process.exit(1);",
  'database.close();',
].join('\n')]);

const originalCxxFlags = process.env.CXXFLAGS;
const backupDirectory = await mkdtemp(join(tmpdir(), 'quizzer-electron-native-'));
let snapshot;
try {
  snapshot = await snapshotNativeArtifacts(sqliteDirectory, backupDirectory);
  delete process.env.CXXFLAGS;
  await rebuild({
    buildPath: projectDirectory,
    electronVersion: electronPackage.version,
    projectRootPath: projectDirectory,
    onlyModules: ['better-sqlite3'],
    extraModules: [],
    force: true,
    buildFromSource: true,
  });
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
  await run(process.execPath, ['scripts/forge.mjs', 'package']);
  const packagedExecutable = packagedElectronExecutable({
    projectDirectory,
    platform: process.platform,
    architecture: process.arch,
  });
  const packagedDetails = await stat(packagedExecutable);
  if (!packagedDetails.isFile()) throw new Error(`Packaged Electron executable is not a file: ${packagedExecutable}`);
  const playwrightCommand = playwrightCommandForPlatform({
    platform: process.platform,
    nodeExecutable: process.execPath,
    projectDirectory,
    useXvfb: process.env.ELECTRON_SHELL_USE_XVFB === '1',
  });
  await run(playwrightCommand.command, playwrightCommand.args, {
    ...process.env,
    QUIZZER_PACKAGED_ELECTRON_EXECUTABLE: packagedExecutable,
  });
} finally {
  try {
    await stopChildren();
  } finally {
    try {
      if (originalCxxFlags === undefined) delete process.env.CXXFLAGS;
      else process.env.CXXFLAGS = originalCxxFlags;
      if (snapshot) await restoreNativeArtifacts(snapshot);
    } finally {
      await rm(backupDirectory, { recursive: true, force: true });
    }
  }
}

await verifyNodeSqlite();
