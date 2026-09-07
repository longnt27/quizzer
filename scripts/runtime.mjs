import { spawn } from 'node:child_process';
import { defaultAppDataDirectory, databasePathFor } from '../server/paths.mjs';
import { ensureServiceToken } from '../server/auth.mjs';
import { terminateChild } from '../server/process-control.mjs';

export { terminateChild } from '../server/process-control.mjs';

/**
 * Build the environment shared by the loopback service and Vite.
 * The token is consumed by Vite's server-side API proxy and is never exposed
 * as a VITE_* renderer variable.
 */
export const authenticatedRuntimeEnvironment = async (environment = process.env) => {
  const appDataDirectory = defaultAppDataDirectory({ environment });
  const serviceToken = await ensureServiceToken(appDataDirectory, environment);
  const runtimeEnvironment = { ...environment };
  delete runtimeEnvironment.VITE_QUIZZER_API_TOKEN;
  return {
    ...runtimeEnvironment,
    QUIZZER_APP_DATA_DIR: appDataDirectory,
    QUIZZER_DATABASE_PATH: environment.QUIZZER_DATABASE_PATH || databasePathFor(appDataDirectory),
    QUIZZER_API_TOKEN: serviceToken,
  };
};

const waitForExit = child => {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('error', finish);
    child.once('exit', finish);
    child.once('close', finish);
  });
};

export const stopChildren = async (children, signal = 'SIGTERM', {
  timeoutMs = 5_000,
  platform = process.platform,
  spawnProcess = spawn,
} = {}) => {
  for (const child of children) terminateChild(child, signal, { platform, spawnProcess });
  const settled = Promise.all(children.map(waitForExit));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return settled;
  await Promise.race([
    settled,
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
  if (children.some(child => child.exitCode === null && !child.signalCode)) {
    for (const child of children) terminateChild(child, 'SIGKILL', { platform, spawnProcess });
    await Promise.race([
      settled,
      new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs || 1_000, 1_000))),
    ]);
  }
};

/** Wait for the first child failure/exit, then tear down its siblings. */
export const superviseChildren = async (children, {
  processHandle = process,
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 5_000,
} = {}) => {
  let signal;
  let signalResolve;
  const signalPromise = new Promise(resolve => { signalResolve = resolve; });
  const onSignal = value => {
    signal = value;
    signalResolve(value);
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  processHandle.once('SIGINT', onInterrupt);
  processHandle.once('SIGTERM', onTerminate);
  const firstExit = Promise.race(children.map(child => new Promise(resolve => {
    child.once('error', error => resolve({ child, code: 1, error }));
    child.once('exit', (code, childSignal) => resolve({
      child,
      code: typeof code === 'number' ? code : 1,
      signal: childSignal,
    }));
  })));
  const result = await Promise.race([firstExit, signalPromise.then(value => ({
    code: value === 'SIGTERM' ? 143 : 130,
    signal: value,
  }))]);
  processHandle.removeListener('SIGINT', onInterrupt);
  processHandle.removeListener('SIGTERM', onTerminate);
  await stopChildren(children, signal || 'SIGTERM', { timeoutMs, platform, spawnProcess });
  return result;
};
