/**
 * Fetch wrapper that automatically injects:
 *   - the active company ID header (existing)
 *   - the CSRF token header for non-idempotent requests (BL-22)
 *   - PRD-10 Layer 1: a single 401-retry that calls /api/auth/refresh and replays
 *     the original request once. Concurrent 401s share one in-flight refresh.
 * Use this instead of raw fetch() for all accounting API calls.
 */

import { clearTenantClientState } from './auth/clearTenantClientState';
import type { ResponseFor } from './apiRoutes';

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

/** Error carrying the HTTP status, so callers can branch on it (retry, backoff)
 *  rather than string-matching a message. */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * Throw on a failed response, using the server's own message when it sent one.
 *
 * `apiFetch` RESOLVES on 4xx/5xx — it only intercepts 401 to refresh — so
 * `await apiFetch(...)` inside a try/catch catches nothing on an error status.
 * Every mutating caller must pass its response through here, or the failure is
 * silently discarded and the UI looks like a dead button.
 */
export async function assertOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;

  let message = fallback;
  try {
    const json = JSON.parse(await res.text()) as {
      message?: string;
      error?: { message?: string };
    };
    message = json.message || json.error?.message || fallback;
  } catch { /* empty or non-JSON body — keep the caller's fallback */ }

  throw new ApiRequestError(message, res.status);
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const init = buildRequest(options);
  const res = await fetch(url, init);

  // Pass through anything that isn't a 401, and never recurse into the refresh
  // endpoint itself (preventing redirect/refresh loops).
  if (res.status !== 401 || isRefreshUrl(url)) return res;

  const refreshed = await refreshSession();
  if (!refreshed) {
    // The PDF print pipeline (src/lib/pdf/renderPagePdf.ts) authenticates
    // only the one report-data endpoint via a print token; AppLayout's own
    // background calls (preferences, setup-guide) have no GoTrue session and
    // 401 as expected. Bouncing the browser to /login mid-render would abort
    // the print job before page.pdf() runs, so a print-mode request suppresses
    // the redirect instead of following it.
    const isPrintMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('print') === '1';
    if (typeof window !== 'undefined' && !isPrintMode && !window.location.pathname.startsWith('/login')) {
      // Wipe tenant-scoped client state before bouncing so the next login on
      // this browser does not inherit the previous user's active company.
      // The /login page also defends here, but clearing on the redirect side
      // covers the brief window where the redirect target may render auth
      // shells before /login mounts.
      clearTenantClientState();
      window.location.href = LOGIN_REDIRECT;
    }
    return res;
  }

  // Replay the original request exactly once. CSRF token may have rotated
  // alongside the access cookie; rebuild headers fresh.
  const replayInit = buildRequest(options);
  return fetch(url, replayInit);
}

/** Thrown when the server replied 2xx but the body was not the standard
 *  `{ success, data }` envelope — e.g. an HTML error page from a proxy, or a
 *  handler that bypasses `apiResponse`. Surfacing this beats silently handing
 *  the caller an `undefined` that only fails three lines later. */
export class ApiEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiEnvelopeError';
  }
}

/**
 * Typed JSON fetch: performs the request, throws on a non-OK status, verifies
 * the `apiResponse` envelope, and returns the unwrapped `data` payload.
 *
 * The return type is INFERRED FROM THE URL via the registry in `apiRoutes.ts`.
 * There is deliberately no `<T>` parameter to pass: a caller-supplied type is
 * just a guess, and a confirmed-but-wrong guess is the exact defect this
 * replaces (see `project_api_envelope_defect_class`). Register the route
 * instead, and let a wrong field name be a compile error.
 *
 * Unregistered routes return `unknown`, which cannot be used without
 * narrowing — so this is a ratchet, not a convention.
 *
 * @throws {ApiRequestError} on any non-2xx status, carrying the server message.
 * @throws {ApiEnvelopeError} on a 2xx that is not a `{ success, data }` envelope.
 */
export async function apiJson<U extends string>(
  url: U,
  options?: RequestInit,
): Promise<ResponseFor<U>> {
  const res = await apiFetch(url, options);
  await assertOk(res, `Request to ${url} failed`);

  // NOTE: a 204 is deliberately NOT special-cased into `undefined`. Casting an
  // empty body to `ResponseFor<U>` would lie to the type system — the caller
  // would hold something typed as a full payload that is actually undefined,
  // and crash on first property access with no compile-time warning. No
  // registered route returns 204 today; if one ever does, it fails loudly
  // below and can be given a type that admits the empty case.
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiEnvelopeError(`${url} returned a non-JSON body`);
  }

  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    throw new ApiEnvelopeError(`${url} returned a body without a 'data' envelope`);
  }

  return (parsed as { data: ResponseFor<U> }).data;
}
