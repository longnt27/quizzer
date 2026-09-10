import { authorizationHeaderForToken } from './serviceAuth.mjs';

interface ServiceErrorPayload {
  error?: string;
  code?: string;
  confirmationRequired?: boolean;
  reasons?: string[];
  details?: Record<string, unknown>;
}

export class ServiceApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly confirmationRequired?: boolean;
  readonly reasons?: string[];
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    confirmationRequired?: boolean,
    reasons?: string[],
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceApiError';
    this.status = status;
    this.code = code;
    this.confirmationRequired = confirmationRequired;
    this.reasons = reasons;
    this.details = details;
  }
}

export const serviceAuthorizationHeader = () => {
  return authorizationHeaderForToken(import.meta.env.VITE_QUIZZER_API_TOKEN);
};

let integrationActionTrigger: HTMLButtonElement | null = null;

const isIntegrationMutation = (path: string, init: RequestInit) => {
  const method = (init.method ?? 'GET').toUpperCase();
  return method === 'POST' && /^\/api\/(?:v1\/)?integrations\/.+\/(?:install|connect|pull)$/.test(path);
};

const guardIntegrationTrigger = () => {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  if (!(active instanceof HTMLButtonElement)) return;
  if (integrationActionTrigger && integrationActionTrigger !== active) releaseIntegrationTrigger();
  integrationActionTrigger = active;
  active.disabled = true;
  active.setAttribute('aria-busy', 'true');
};

const releaseIntegrationTrigger = () => {
  if (!integrationActionTrigger) return;
  if (integrationActionTrigger.isConnected) {
    integrationActionTrigger.disabled = false;
    integrationActionTrigger.removeAttribute('aria-busy');
  }
  integrationActionTrigger = null;
};

export const serviceFetch = async (path: string, init: RequestInit = {}) => {
  if (!path.startsWith('/api/')) throw new Error('Service API paths must start with /api/');
  const headers = new Headers(init.headers);
  const authorization = serviceAuthorizationHeader();
  if (authorization && !headers.has('Authorization')) headers.set('Authorization', authorization);
  const guardedMutation = isIntegrationMutation(path, init);
  if (guardedMutation) guardIntegrationTrigger();
  try {
    const response = await fetch(path, { ...init, headers });
    if (path === '/api/integrations' || (guardedMutation && !response.ok)) releaseIntegrationTrigger();
    return response;
  } catch (error) {
    if (guardedMutation || path === '/api/integrations') releaseIntegrationTrigger();
    throw error;
  }
};

const parseServiceResponse = async <Response>(response: globalThis.Response): Promise<Response> => {
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json() as Response & ServiceErrorPayload
    : await response.text() as Response;
  if (!response.ok) {
    const details = typeof payload === 'object' && payload !== null ? payload as ServiceErrorPayload : undefined;
    throw new ServiceApiError(
      details?.error || `Quizzer service returned ${response.status}`,
      response.status,
      details?.code,
      details?.confirmationRequired,
      details?.reasons,
      details?.details,
    );
  }
  return payload;
};

export const serviceRequest = async <Response>(path: string, init: RequestInit = {}): Promise<Response> => {
  if (!path.startsWith('/api/v1/')) throw new Error('Service API paths must start with /api/v1/');
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await serviceFetch(path, { ...init, headers });
  return parseServiceResponse<Response>(response);
};

export const serviceJson = async <Response>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
  init: Omit<RequestInit, 'body' | 'method'> = {},
): Promise<Response> => {
  // The embedding installer deliberately rejects a model that differs from the
  // current resolved setting. Make a confirmed download authoritative by
  // selecting that model first, so a cached Plugins & Models snapshot cannot
  // turn a valid bge-m3 click into a silent stale-model rejection.
  if (path === '/api/integrations/embeddings/install' && method === 'POST' && body && typeof body === 'object') {
    const model = (body as { model?: unknown }).model;
    const confirmed = (body as { confirmed?: unknown }).confirmed;
    if (confirmed === true && typeof model === 'string' && model.trim()) {
      await serviceRequest('/api/v1/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { 'embeddings.model': model.trim() } }),
      });
      window.dispatchEvent(new Event('quizzer:settings-changed'));
    }
  }

  const requestInit: RequestInit = {
    ...init,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  if (path.startsWith('/api/v1/')) return serviceRequest<Response>(path, requestInit);

  const headers = new Headers(requestInit.headers);
  if (requestInit.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await serviceFetch(path, { ...requestInit, headers });
  return parseServiceResponse<Response>(response);
};

export interface TwoPhaseActionOptions {
  onConfirmationRequired: (reasons: string[], details?: Record<string, unknown>) => Promise<boolean>;
}

export const executeTwoPhaseAction = async <T>(
  action: (confirmationToken?: string) => Promise<T>,
  options: TwoPhaseActionOptions,
): Promise<T | null> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ServiceApiError && error.confirmationRequired) {
      const confirmationToken = error.details?.confirmationToken;
      if (typeof confirmationToken !== 'string' || !/^[a-f0-9]{64}$/.test(confirmationToken)) {
        throw new ServiceApiError('Quizzer service returned an invalid plugin confirmation challenge', error.status, error.code);
      }
      const confirmed = await options.onConfirmationRequired(error.reasons || [], error.details);
      if (!confirmed) return null;
      return await action(confirmationToken);
    }
    throw error;
  }
};