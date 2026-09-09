import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  INSTALLED_APPLICATION_PATH,
  macosUpdateHelperSource,
  prepareMacosDmgUpdate,
  validateInstalledApplicationPath,
} from '../desktop/macos-update.mjs';

test('macOS automatic replacement accepts only the installed Applications bundle by default', () => {
  assert.equal(validateInstalledApplicationPath('/Applications/Quizzer.app'), INSTALLED_APPLICATION_PATH);
  assert.throws(
    () => validateInstalledApplicationPath('/Users/example/Applications/Quizzer.app'),
    /require Quizzer to run from \/Applications\/Quizzer\.app/,
  );
  assert.throws(
    () => validateInstalledApplicationPath('/tmp/Quizzer.app'),
    /require Quizzer to run from \/Applications\/Quizzer\.app/,
  );
});

test('macOS replacement helper keeps backups out of Spotlight and restores on relaunch failure', () => {
  const source = macosUpdateHelperSource();
  assert.match(source, /Quizzer did not exit before the update timeout/);
  assert.match(source, /\/usr\/bin\/open -n "\$target_app"/);
  assert.match(source, /\/bin\/mv "\$previous_app" "\$target_app"/);
  assert.match(source, /\/bin\/rm -rf "\$staging_dir"[\s\S]+\/usr\/bin\/open/);
  assert.doesNotMatch(source, /previous[^\n]*\.app/);
});

test('prepares a verified DMG bundle with fixed native commands and a non-app staging name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-macos-update-test-'));
  const installedApp = join(directory, 'Applications', 'Quizzer.app');
  const userDataDir = join(directory, 'user-data');
  const stagingDirectory = join(userDataDir, 'updates', 'staging');
  const dmgPath = join(stagingDirectory, 'Quizzer.dmg');
  const calls = [];

  await mkdir(join(installedApp, 'Contents'), { recursive: true });
  await mkdir(stagingDirectory, { recursive: true });
  await writeFile(dmgPath, 'verified dmg bytes');

  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === '/usr/bin/hdiutil' && args[0] === 'attach') {
      const mountDirectory = args[args.indexOf('-mountpoint') + 1];
      await mkdir(join(mountDirectory, 'Quizzer.app', 'Contents'), { recursive: true });
      await writeFile(join(mountDirectory, 'Quizzer.app', 'Contents', 'Info.plist'), 'test plist');
    }
    if (command === '/usr/libexec/PlistBuddy') {
      return { stdout: args[1].includes('CFBundleIdentifier') ? 'dev.quizzer.app\n' : '1.2.0\n', stderr: '' };
    }
    if (command === '/usr/bin/ditto') {
      await mkdir(args.at(-1), { recursive: true });
    }
    return { stdout: '', stderr: '' };
  };

  try {
    const plan = await prepareMacosDmgUpdate({
      dmgPath,
      userDataDir,
      applicationPath: installedApp,
      requiredApplicationPath: installedApp,
      currentPid: 1234,
      targetVersion: '1.2.0',
      runner,
    });

    assert.equal(plan.command, '/bin/sh');
    assert.equal(plan.args[1], '1234');
    assert.equal(plan.args[2], installedApp);
    assert.match(plan.args[3], /\/Quizzer\.next$/);
    assert.match(plan.args[4], /\/Quizzer\.previous$/);
    assert.doesNotMatch(plan.args[3], /\.app$/);
    assert.doesNotMatch(plan.args[4], /\.app$/);
    assert.equal((await readFile(plan.args[0], 'utf8')), macosUpdateHelperSource());

    assert.deepEqual(calls.map(call => call.command), [
      '/usr/bin/hdiutil',
      '/usr/libexec/PlistBuddy',
      '/usr/libexec/PlistBuddy',
      '/usr/bin/ditto',
      '/usr/bin/hdiutil',
    ]);
    assert.equal(calls[0].args[0], 'attach');
    assert.match(calls[3].args[0], /\/mount\/Quizzer\.app$/);
    assert.match(calls[3].args[1], /\/Quizzer\.next$/);
    assert.equal(calls[4].args[0], 'detach');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
