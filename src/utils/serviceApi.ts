interface ServiceErrorPayload {
  error?: string;
  code?: string;
}

export class ServiceApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ServiceApiError';
    this.status = status;
    this.code = code;
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
    throw new ServiceApiError(details?.error || `Quizzer service returned ${response.status}`, response.status, details?.code);
  }
  return payload;
};

export const serviceJson = <Response>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown) => serviceRequest<Response>(path, {
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
