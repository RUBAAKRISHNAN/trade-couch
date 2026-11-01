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

/**
 * POST that reads a Server-Sent Events response (`data: {...}` events) and calls onEvent for each one.
 * Uses the same session handling as api(): one silent token refresh on 401.
 */
export async function apiStream(
  path: string,
  body: unknown,
  onEvent: (e: Record<string, unknown>) => void,
  signal?: AbortSignal,
  retry = true,
): Promise<void> {
  const token = useAuth.getState().accessToken;
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401 && token && retry && (await refreshSession()))
    return apiStream(path, body, onEvent, signal, false);
  if (!res.ok || !res.body) {
    let err: { code?: string; message?: string } = {};
    try {
      err = (await res.json()).error ?? {};
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, err.code ?? 'HTTP_' + res.status, err.message ?? res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line.startsWith('data:')) onEvent(JSON.parse(line.slice(5).trim()));
    }
    if (done) break;
  }
}
