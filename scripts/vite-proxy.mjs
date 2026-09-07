/**
 * Attach the service credential to requests made through Vite's server-side
 * API proxy. A browser-supplied Authorization header is always replaced when
 * a service credential is configured; without one, development stays open.
 */
export const configureServiceProxy = (proxy, serviceToken) => {
  const token = typeof serviceToken === 'string' ? serviceToken.trim() : '';
  if (!token) return proxy;
  const authorization = `Bearer ${token}`;
  proxy.on('proxyReq', proxyRequest => {
    proxyRequest.setHeader('authorization', authorization);
  });
  return proxy;
};
