/** Return the renderer's private service credential header without logging it. */
export const authorizationHeaderForToken = token => (
  typeof token === 'string' && token.length > 0 ? `Bearer ${token}` : undefined
);
