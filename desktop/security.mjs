const parsedUrl = value => {
  try { return new URL(value); }
  catch { return undefined; }
};

export const isAllowedExternalUrl = value => {
  const url = parsedUrl(value);
  return Boolean(url && url.protocol === 'https:' && !url.username && !url.password);
};

export const isTrustedRendererUrl = (value, developmentUrl) => {
  const url = parsedUrl(value);
  if (!url || url.username || url.password) return false;
  if (developmentUrl) {
    const expected = parsedUrl(developmentUrl);
    return Boolean(expected && ['http:', 'https:'].includes(expected.protocol) && url.origin === expected.origin);
  }
  return url.protocol === 'quizzer:' && url.hostname === 'app' && !url.port;
};
