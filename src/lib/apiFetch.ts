/**
 * Fetch wrapper that automatically injects:
 *   - the active company ID header (existing)
 *   - the CSRF token header for non-idempotent requests (BL-22)
 *   - PRD-10 Layer 1: a single 401-retry that calls /api/auth/refresh and replays
 *     the original request once. Concurrent 401s share one in-flight refresh.
 * Use this instead of raw fetch() for all accounting API calls.
 */

const COMPANY_STORAGE_KEY = 'isaflow_active_company';
const CSRF_COOKIE = 'isaflow_csrf';
const REFRESH_URL = '/api/auth/refresh';
const LOGIN_REDIRECT = '/login?reason=session-expired';

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  return match ? match.slice(CSRF_COOKIE.length + 1) : null;
}

let inFlightRefresh: Promise<boolean> | null = null;

/**
 * Calls /api/auth/refresh exactly once even if N concurrent 401s race in.
 * Resolves true if the refresh succeeded (cookies rotated), false otherwise.
 */
function refreshSession(): Promise<boolean> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    try {
      const r = await fetch(REFRESH_URL, { method: 'POST', credentials: 'include' });
      return r.ok;
    } catch {
      return false;
    } finally {
      // Reset on next tick so retries triggered by this refresh don't share the
      // resolved promise with a fresh round of 401s that arrive later.
      setTimeout(() => {
        inFlightRefresh = null;
      }, 0);
    }
  })();
  return inFlightRefresh;
}

function buildRequest(options?: RequestInit): RequestInit & { headers: Headers } {
  const headers = new Headers(options?.headers);
  const method = (options?.method ?? 'GET').toUpperCase();

  if (options?.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(COMPANY_STORAGE_KEY);
    if (stored) {
      try {
        const { id } = JSON.parse(stored);
        if (id) headers.set('X-Company-Id', id);
      } catch {
        // Invalid JSON — ignore
      }
    }
  }

  // BL-22: mirror the CSRF cookie into the X-CSRF-Token header on non-idempotent methods.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('X-CSRF-Token')) {
    const csrf = readCsrfCookie();
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }

  return { ...options, headers, credentials: 'include' };
}

/** Exact path match (ignores query string and hash) so siblings like
 *  `/api/auth/refresh-token` aren't accidentally treated as the refresh
 *  endpoint by a substring check, and crafted paths like
 *  `/proxy/api/auth/refresh` don't accidentally match either.
 */
function isRefreshUrl(url: string): boolean {
  return url.split(/[?#]/)[0] === REFRESH_URL;
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const init = buildRequest(options);
  const res = await fetch(url, init);

  // Pass through anything that isn't a 401, and never recurse into the refresh
  // endpoint itself (preventing redirect/refresh loops).
  if (res.status !== 401 || isRefreshUrl(url)) return res;

  const refreshed = await refreshSession();
  if (!refreshed) {
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = LOGIN_REDIRECT;
    }
    return res;
  }

  // Replay the original request exactly once. CSRF token may have rotated
  // alongside the access cookie; rebuild headers fresh.
  const replayInit = buildRequest(options);
  return fetch(url, replayInit);
}
