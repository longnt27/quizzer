import { spawn } from 'node:child_process';
import { defaultAppDataDirectory, databasePathFor } from '../server/paths.mjs';
import { ensureServiceToken } from '../server/auth.mjs';

/**
 * Build the environment shared by the loopback service and the Vite renderer.
 * The token is deliberately returned only as an environment value; callers
 * must not print it.
 */
export const authenticatedRuntimeEnvironment = async (environment = process.env) => {
  const appDataDirectory = defaultAppDataDirectory({ environment });
  const serviceToken = await ensureServiceToken(appDataDirectory, environment);
  return {
    ...environment,
    QUIZZER_APP_DATA_DIR: appDataDirectory,
    QUIZZER_DATABASE_PATH: environment.QUIZZER_DATABASE_PATH || databasePathFor(appDataDirectory),
    QUIZZER_API_TOKEN: serviceToken,
    VITE_QUIZZER_API_TOKEN: serviceToken,
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

export const terminateChild = (child, signal = 'SIGTERM', {
  platform = process.platform,
  spawnProcess = spawn,
} = {}) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (platform === 'win32' && child.pid) {
    // Node's signal emulation does not reliably terminate npm's process tree.
    try {
      const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once?.('error', () => { try { child.kill(); } catch { /* Already exited. */ } });
    } catch { try { child.kill(); } catch { /* Already exited. */ } }
    return;
  }
  try { child.kill(signal); } catch { /* Already exited. */ }
};

export const stopChildren = async (children, signal = 'SIGTERM', { timeoutMs = 5_000 } = {}) => {
  for (const child of children) terminateChild(child, signal);
  const settled = Promise.all(children.map(waitForExit));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return settled;
  await Promise.race([
    settled,
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
  if (children.some(child => child.exitCode === null && !child.signalCode)) {
    for (const child of children) terminateChild(child, 'SIGKILL');
    await Promise.race([
      settled,
      new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs || 1_000, 1_000))),
    ]);
  }
};

/** Wait for the first child failure/exit, then tear down its siblings. */
export const superviseChildren = async (children) => {
  let signal;
  let signalResolve;
  const signalPromise = new Promise(resolve => { signalResolve = resolve; });
  const onSignal = value => {
    signal = value;
    signalResolve(value);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const firstExit = Promise.race(children.map(child => new Promise(resolve => {
    child.once('error', error => resolve({ child, code: 1, error }));
    child.once('exit', (code, childSignal) => resolve({
      child,
      code: typeof code === 'number' ? code : 1,
      signal: childSignal,
    }));
  })));
  const result = await Promise.race([firstExit, signalPromise.then(value => ({ code: 130, signal: value }))]);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  await stopChildren(children, signal ? 'SIGINT' : 'SIGTERM');
  return result;
};
