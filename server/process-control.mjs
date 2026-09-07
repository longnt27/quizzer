import { spawn } from 'node:child_process';

/** Terminate one child, including its Windows process tree when available. */
export const terminateChild = (child, signal = 'SIGTERM', {
  platform = process.platform,
  spawnProcess = spawn,
} = {}) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (platform === 'win32' && child.pid) {
    try {
      const force = signal === 'SIGKILL';
      const args = ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])];
      const killer = spawnProcess('taskkill', args, { stdio: 'ignore' });
      let failed = false;
      const fallback = () => {
        if (failed) return;
        failed = true;
        try { child.kill(signal); } catch { /* Already exited. */ }
      };
      killer.once?.('error', fallback);
      killer.once?.('exit', code => { if (code !== 0) fallback(); });
      killer.once?.('close', code => { if (code !== 0) fallback(); });
    } catch { try { child.kill(signal); } catch { /* Already exited. */ } }
    return;
  }
  try { child.kill(signal); } catch { /* Already exited. */ }
};
