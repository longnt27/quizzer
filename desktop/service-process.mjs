import { join } from 'node:path';

export const executableSearchPath = (environment = process.env, {
  platform = process.platform,
  homeDirectory = environment.HOME || environment.USERPROFILE || '',
} = {}) => {
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const existing = String(environment.PATH || environment.Path || '').split(pathDelimiter).filter(Boolean);
  const candidates = platform === 'win32'
    ? [
        environment.APPDATA && join(environment.APPDATA, 'npm'),
        environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
        environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'Programs', 'Ollama'),
      ]
    : [
        homeDirectory && join(homeDirectory, '.local', 'bin'),
        homeDirectory && join(homeDirectory, '.npm-global', 'bin'),
        homeDirectory && join(homeDirectory, '.npm', 'bin'),
        homeDirectory && join(homeDirectory, '.volta', 'bin'),
        homeDirectory && join(homeDirectory, '.bun', 'bin'),
        homeDirectory && join(homeDirectory, '.cargo', 'bin'),
        platform === 'darwin' && homeDirectory && join(homeDirectory, 'Library', 'pnpm'),
        platform === 'darwin' && '/opt/homebrew/bin',
        '/usr/local/bin',
      ];
  const seen = new Set();
  return [...existing, ...candidates.filter(Boolean)].filter(entry => {
    const key = platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(pathDelimiter);
};

export const isValidServicePort = port => Number.isSafeInteger(port) && port >= 1 && port <= 65_535;

export const serviceRestartDelay = attempt => {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('Service restart attempt must be a non-negative integer');
  return Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
};

export const waitForServiceReady = (service, { timeoutMs = 120_000 } = {}) => new Promise((resolve, reject) => {
  let settled = false;
  const cleanup = () => {
    clearTimeout(timeout);
    service.off('message', onMessage);
    service.off('exit', onExit);
    service.off('error', onError);
  };
  const finish = (error, port) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve(port);
  };
  const onMessage = message => {
    if (message?.type === 'quizzer-service-error') {
      finish(new Error(message.message || 'Quizzer local service failed to start'));
      return;
    }
    if (message?.type !== 'quizzer-service-ready') return;
    if (!isValidServicePort(message.port)) {
      finish(new Error('Quizzer local service reported an invalid port'));
      return;
    }
    finish(undefined, message.port);
  };
  const onExit = code => finish(new Error(`Quizzer local service exited during startup (${code})`));
  const onError = error => finish(error instanceof Error ? error : new Error(String(error)));
  const timeout = setTimeout(() => finish(new Error(`Quizzer local service did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds`)), timeoutMs);
  service.on('message', onMessage);
  service.once('exit', onExit);
  service.once('error', onError);
});
