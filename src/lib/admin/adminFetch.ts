import { apiFetch } from '@/lib/apiFetch';

/** Header `withAdmin` requires on every non-GET (CSRF mitigation, F-04). */
export const ADMIN_REQUEST_HEADER = 'X-Admin-Request';

/**
 * `apiFetch` for `/api/admin/*` routes: same signature and semantics, but always
 * sends `X-Admin-Request: true`, which `withAdmin` demands on any non-GET. A
 * caller that forgets it gets a 403 that looks like a dead button, so admin UI
 * calls go through here rather than setting the header by hand.
 */
export function adminFetch(url: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  headers.set(ADMIN_REQUEST_HEADER, 'true');
  return apiFetch(url, { ...options, headers });
}
