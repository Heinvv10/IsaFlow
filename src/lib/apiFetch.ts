/**
 * Fetch wrapper that automatically injects:
 *   - the active company ID header (existing)
 *   - the CSRF token header for non-idempotent requests (BL-22)
 * Use this instead of raw fetch() for all accounting API calls.
 */

const COMPANY_STORAGE_KEY = 'isaflow_active_company';
const CSRF_COOKIE = 'isaflow_csrf';

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  return match ? match.slice(CSRF_COOKIE.length + 1) : null;
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
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

  return fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });
}
