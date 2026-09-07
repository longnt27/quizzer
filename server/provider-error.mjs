/** Keep provider failures structured at the service boundary. */
export class ProviderError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const normalizeProviderError = error => {
  if (error?.status !== undefined && error?.code !== undefined) return error;
  if (error?.name === 'AbortError') return error;

  const message = error instanceof Error ? error.message : 'Generation failed';
  if (/usage limit|rate limit|quota|too many requests|insufficient (?:balance|credits)|credit balance|capacity/i.test(message)) {
    return new ProviderError(message, 429, 'provider_limit');
  }
  if (/not logged in|unauthorized|authentication|api key|sign[ -]?in|login required/i.test(message)) {
    return new ProviderError(message, 401, 'provider_auth');
  }
  if (error?.code === 'ENOENT' || /command not found|executable.*not found|is not installed/i.test(message)) {
    return new ProviderError(message, 503, 'provider_unavailable');
  }
  return error;
};
