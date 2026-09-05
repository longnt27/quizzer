import DatabaseImplementation from 'better-sqlite3/lib/database.js';
import SqliteError from 'better-sqlite3/lib/sqlite-error.js';
import { join } from 'node:path';
import { materializeRuntimeAsset, runningAsSingleExecutable } from '../server/runtime-assets.mjs';

let nativeBinding;

const loadNativeBinding = async () => {
  if (nativeBinding) return nativeBinding;
  if (!runningAsSingleExecutable) return undefined;
  const appDataDirectory = process.env.QUIZZER_APP_DATA_DIR;
  if (!appDataDirectory) throw new Error('QUIZZER_APP_DATA_DIR must be configured before opening the database');
  const addonPath = await materializeRuntimeAsset(
    'better_sqlite3.node',
    join(appDataDirectory, 'runtime', `node-${process.versions.modules}`, 'better_sqlite3.node'),
  );
  const addonModule = { exports: {} };
  process.dlopen(addonModule, addonPath);
  nativeBinding = addonModule.exports;
  return nativeBinding;
};

const QuizzerDatabase = function QuizzerDatabase(filename, options = {}) {
  if (!new.target) return new QuizzerDatabase(filename, options);
  const binding = runningAsSingleExecutable ? nativeBinding : undefined;
  if (runningAsSingleExecutable && !binding) {
    throw new Error('Quizzer SQLite was not initialized before opening the database');
  }
  return new DatabaseImplementation(filename, binding ? { ...options, nativeBinding: binding } : options);
};

QuizzerDatabase.prototype = DatabaseImplementation.prototype;
Object.setPrototypeOf(QuizzerDatabase, DatabaseImplementation);
QuizzerDatabase.SqliteError = SqliteError;

export const initializeEmbeddedSqlite = loadNativeBinding;
export { SqliteError };
export default QuizzerDatabase;
