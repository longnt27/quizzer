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
  const token = import.meta.env.VITE_QUIZZER_API_TOKEN;
  return token ? `Bearer ${token}` : undefined;
};

export const serviceFetch = (path: string, init: RequestInit = {}) => {
  if (!path.startsWith('/api/')) throw new Error('Service API paths must start with /api/');
  const headers = new Headers(init.headers);
  const authorization = serviceAuthorizationHeader();
  if (authorization && !headers.has('Authorization')) headers.set('Authorization', authorization);
  return fetch(path, { ...init, headers });
};

export const serviceRequest = async <Response>(path: string, init: RequestInit = {}): Promise<Response> => {
  if (!path.startsWith('/api/v1/')) throw new Error('Service API paths must start with /api/v1/');
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await serviceFetch(path, { ...init, headers });
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

export const serviceJson = <Response>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
  init: Omit<RequestInit, 'body' | 'method'> = {},
) => serviceRequest<Response>(path, {
  ...init,
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

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
