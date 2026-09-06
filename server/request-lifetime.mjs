const abortError = message => Object.assign(new Error(message), { name: 'AbortError' });

export const bindRequestCancellation = (request, response, message = 'Client disconnected') => {
  if (typeof request?.once !== 'function' || typeof request?.removeListener !== 'function'
    || typeof response?.once !== 'function' || typeof response?.removeListener !== 'function') {
    throw new Error('Request cancellation requires HTTP request and response emitters');
  }
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(abortError(message));
  };
  const responseClosed = () => {
    if (!response.writableEnded) abort();
  };
  request.once('aborted', abort);
  response.once('close', responseClosed);
  return {
    signal: controller.signal,
    dispose() {
      request.removeListener('aborted', abort);
      response.removeListener('close', responseClosed);
    },
  };
};
