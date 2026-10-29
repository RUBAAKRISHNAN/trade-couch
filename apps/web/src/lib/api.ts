import { useAuth } from '@/stores/auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

let refreshing: Promise<boolean> | null = null;

/** Exchange the httpOnly refresh cookie for a new access token. Single-flight: concurrent 401s share one refresh. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        useAuth.getState().clear();
        return false;
      }
      const body = await res.json();
      useAuth.getState().setSession(body.accessToken, body.user);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; retry?: boolean } = {},
): Promise<T> {
  const token = useAuth.getState().accessToken;
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 && token && init.retry !== false && !path.startsWith('/auth/')) {
    if (await refreshSession()) return api<T>(path, { ...init, retry: false });
  }
  if (!res.ok) {
    let err: { code?: string; message?: string; details?: unknown } = {};
    try {
      err = (await res.json()).error ?? {};
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(
      res.status,
      err.code ?? 'HTTP_' + res.status,
      err.message ?? res.statusText,
      err.details,
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
