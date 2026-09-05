import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultAppDataDirectory = ({ platform = process.platform, environment = process.env, home = homedir() } = {}) => {
  if (environment.QUIZZER_APP_DATA_DIR) return environment.QUIZZER_APP_DATA_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Quizzer');
  if (platform === 'win32') return join(environment.APPDATA || environment.LOCALAPPDATA || join(home, 'AppData', 'Roaming'), 'Quizzer');
  return join(environment.XDG_DATA_HOME || join(home, '.local', 'share'), 'quizzer');
};

export const databasePathFor = appDataDirectory => join(appDataDirectory, 'data', 'quizzer.sqlite');

export const sparseIndexPathFor = appDataDirectory => join(appDataDirectory, 'indexes', 'sparse.sqlite');
