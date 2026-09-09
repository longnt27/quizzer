import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';

export const QUIZZER_BUNDLE_IDENTIFIER = 'dev.quizzer.app';
export const INSTALLED_APPLICATION_PATH = '/Applications/Quizzer.app';

const HELPER_SOURCE = `#!/bin/sh
set -u

current_pid="$1"
target_app="$2"
next_app="$3"
previous_app="$4"
staging_dir="$5"
preparation_dir="$6"
log_file="$7"

exec >>"$log_file" 2>&1

attempt=0
while /bin/kill -0 "$current_pid" 2>/dev/null && [ "$attempt" -lt 120 ]; do
  /bin/sleep 0.25
  attempt=$((attempt + 1))
done

if /bin/kill -0 "$current_pid" 2>/dev/null; then
  echo "Quizzer did not exit before the update timeout"
  exit 1
fi

if [ ! -d "$target_app" ] || [ ! -d "$next_app" ] || [ -e "$previous_app" ]; then
  echo "Update paths were not in the expected state"
  exit 1
fi

if ! /bin/mv "$target_app" "$previous_app"; then
  echo "Could not retain the installed Quizzer application"
  exit 1
fi

if ! /bin/mv "$next_app" "$target_app"; then
  echo "Could not install the prepared Quizzer application; restoring the previous version"
  /bin/mv "$previous_app" "$target_app"
  exit 1
fi

# Remove the consumed package before relaunch so the new process cannot recover
# it as another pending update. These paths are created and validated by Quizzer.
/bin/rm -rf "$staging_dir"

if /usr/bin/open -n "$target_app"; then
  /bin/rm -rf "$previous_app"
  /bin/rm -rf "$preparation_dir"
  exit 0
fi

echo "Could not relaunch updated Quizzer; restoring the previous version"
/bin/rm -rf "$target_app"
/bin/mv "$previous_app" "$target_app"
/usr/bin/open -n "$target_app"
exit 1
`;

const runFile = (command, args) => new Promise((resolveCommand, reject) => {
  execFile(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(`${command} failed: ${(stderr || error.message).trim()}`));
      return;
    }
    resolveCommand({ stdout, stderr });
  });
});

const assertDirectoryWithoutSymlink = async (path, label) => {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a directory and cannot be a symbolic link`);
  }
};

const assertRegularFileWithoutSymlink = async (path, label) => {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file and cannot be a symbolic link`);
  }
};

export const validateInstalledApplicationPath = (applicationPath, requiredPath = INSTALLED_APPLICATION_PATH) => {
  const resolvedRequiredPath = normalize(resolve(requiredPath));
  if (typeof applicationPath !== 'string' || normalize(resolve(applicationPath)) !== resolvedRequiredPath) {
    throw new Error(`Automatic macOS updates require Quizzer to run from ${resolvedRequiredPath}`);
  }
  return resolvedRequiredPath;
};

export const macosUpdateHelperSource = () => HELPER_SOURCE;

export const prepareMacosDmgUpdate = async ({
  dmgPath,
  userDataDir,
  applicationPath,
  currentPid,
  targetVersion,
  bundleIdentifier = QUIZZER_BUNDLE_IDENTIFIER,
  runner = runFile,
  requiredApplicationPath = INSTALLED_APPLICATION_PATH,
} = {}) => {
  if (typeof dmgPath !== 'string' || !dmgPath) throw new Error('A verified DMG path is required');
  if (typeof userDataDir !== 'string' || !userDataDir) throw new Error('User data directory is required');
  if (!Number.isSafeInteger(currentPid) || currentPid <= 0) throw new Error('A valid Quizzer process ID is required');
  if (typeof targetVersion !== 'string' || !targetVersion) throw new Error('The signed target version is required');

  const targetApp = validateInstalledApplicationPath(applicationPath, requiredApplicationPath);
  await assertDirectoryWithoutSymlink(targetApp, 'Installed Quizzer application');
  await access(dirname(targetApp), constants.W_OK);

  const updatesDirectory = join(userDataDir, 'updates');
  const stagingDirectory = dirname(resolve(dmgPath));
  if (stagingDirectory !== resolve(join(updatesDirectory, 'staging'))) {
    throw new Error('Verified DMG must be inside Quizzer private update staging');
  }
  await assertRegularFileWithoutSymlink(dmgPath, 'Verified DMG');
  await mkdir(updatesDirectory, { recursive: true, mode: 0o700 });
  const preparationDirectory = join(updatesDirectory, `prepared-${randomUUID()}`);
  const mountDirectory = join(preparationDirectory, 'mount');
  const nextApp = join(preparationDirectory, 'Quizzer.next');
  const previousApp = join(preparationDirectory, 'Quizzer.previous');
  const helperPath = join(preparationDirectory, 'install-update.sh');
  const logFile = join(updatesDirectory, 'install-update.log');
  let attached = false;

  await mkdir(mountDirectory, { recursive: true, mode: 0o700 });
  try {
    await runner('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountDirectory, dmgPath]);
    attached = true;

    const entries = await readdir(mountDirectory, { withFileTypes: true });
    const applicationEntries = entries.filter(entry => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'));
    if (applicationEntries.length !== 1) {
      throw new Error(`Verified DMG must contain exactly one application bundle; found ${applicationEntries.length}`);
    }

    const sourceApp = join(mountDirectory, applicationEntries[0].name);
    await assertDirectoryWithoutSymlink(sourceApp, 'DMG application bundle');
    const infoPlist = join(sourceApp, 'Contents', 'Info.plist');
    const identifierResult = await runner('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', infoPlist]);
    if (identifierResult.stdout.trim() !== bundleIdentifier) {
      throw new Error(`DMG application bundle identifier does not match ${bundleIdentifier}`);
    }
    const versionResult = await runner('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', infoPlist]);
    if (versionResult.stdout.trim() !== targetVersion) {
      throw new Error(`DMG application version ${versionResult.stdout.trim() || '(missing)'} does not match signed version ${targetVersion}`);
    }

    await runner('/usr/bin/ditto', [sourceApp, nextApp]);
    await assertDirectoryWithoutSymlink(nextApp, 'Prepared Quizzer application');
    await writeFile(helperPath, HELPER_SOURCE, { mode: 0o700 });
  } catch (error) {
    if (attached) await runner('/usr/bin/hdiutil', ['detach', mountDirectory, '-force']).catch(() => {});
    await rm(preparationDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    await runner('/usr/bin/hdiutil', ['detach', mountDirectory]);
    attached = false;
    await rm(mountDirectory, { recursive: true, force: true });
  } catch (error) {
    if (attached) await runner('/usr/bin/hdiutil', ['detach', mountDirectory, '-force']).catch(() => {});
    await rm(preparationDirectory, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Could not detach the verified update image: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    command: '/bin/sh',
    args: [
      helperPath,
      String(currentPid),
      targetApp,
      nextApp,
      previousApp,
      stagingDirectory,
      preparationDirectory,
      logFile,
    ],
    preparationDirectory,
  };
};
