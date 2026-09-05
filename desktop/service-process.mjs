export const isValidServicePort = port => Number.isSafeInteger(port) && port >= 1 && port <= 65_535;

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
