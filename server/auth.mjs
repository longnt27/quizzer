import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const tokenPath = appDataDirectory => join(appDataDirectory, 'service-token');

export const SERVICE_SESSION_COOKIE = 'quizzer_session';
const defaultSessionMaxAgeSeconds = 30 * 24 * 60 * 60;

const validToken = value => typeof value === 'string' && value.trim().length >= 24 && value.trim().length <= 256;

export const ensureServiceToken = async (appDataDirectory, environment = process.env) => {
  if (validToken(environment.QUIZZER_API_TOKEN)) return environment.QUIZZER_API_TOKEN.trim();
  await mkdir(appDataDirectory, { recursive: true, mode: 0o700 });
  const path = tokenPath(appDataDirectory);
  try {
    const stored = (await readFile(path, 'utf8')).trim();
    if (!validToken(stored)) throw new Error('Quizzer service token is invalid; remove it and restart Quizzer');
    await chmod(path, 0o600).catch(() => {});
    return stored;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(32).toString('base64url');
  try {
    await writeFile(path, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const stored = (await readFile(path, 'utf8')).trim();
    if (!validToken(stored)) throw new Error('Quizzer service token is invalid; remove it and restart Quizzer');
    return stored;
  }
};

const safelyEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const cookieValue = (request, name) => {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return undefined; }
  }
  return undefined;
};

export const serviceSessionCookie = (token, {
  secure = false,
  maxAgeSeconds = defaultSessionMaxAgeSeconds,
} = {}) => {
  if (!validToken(token)) throw new Error('Quizzer service token is invalid');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('Session max age must be a non-negative integer');
  return `${SERVICE_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
};

export const isAuthorizedRequest = (request, token) => {
  const authorization = request.headers.authorization;
  const headerToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : request.headers['x-quizzer-token'];
  const supplied = typeof headerToken === 'string' ? headerToken : cookieValue(request, SERVICE_SESSION_COOKIE);
  return typeof supplied === 'string' && safelyEqual(supplied, token);
};
