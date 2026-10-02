// src/lib/auth/authUpstream.ts
// "The token is invalid" and "the auth provider could not answer" are different
// outcomes. A rejection is answered 401 and clears the cookies; an unavailable
// provider is answered 503 + Retry-After and leaves them alone, so a GoTrue or
// Postgres outage does not log every user out. Both refuse the request.
import type { NextApiResponse } from 'next';
import { log } from '@/lib/logger';

/** Bound on one GoTrue exchange, body included. Unbounded, an outage hangs every request. */
export const AUTH_UPSTREAM_TIMEOUT_MS = 5_000;
export const AUTH_RETRY_AFTER_SECS = 5;
export const AUTH_UNAVAILABLE_ERROR = {
  code: 'AUTH_UNAVAILABLE',
  message: 'Sign-in is temporarily unavailable. Please try again in a moment.',
} as const;

let boundMs = AUTH_UPSTREAM_TIMEOUT_MS;

/** Shortens the bound for a test; returns the restore function. */
export function setAuthUpstreamBoundForTests(ms: number): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setAuthUpstreamBoundForTests works only in a test run (NODE_ENV=test)');
  boundMs = ms;
  return () => { boundMs = AUTH_UPSTREAM_TIMEOUT_MS; };
}

/** The provider gave no verdict on the credential: it failed, timed out or throttled us. */
export class AuthUpstreamUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthUpstreamUnavailableError';
  }
}

/** A status that says nothing about the credential. Client-safe: apiFetch and AuthContext use it too. */
export function isAuthUnavailableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Runs one bounded call to the auth provider. A network error, a timeout or an
 * unavailable status throws AuthUpstreamUnavailableError; any other response,
 * a 401/403 included, is returned for the caller to judge.
 */
export async function callAuthUpstream(
  what: string,
  call: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  let res: Response;
  try {
    res = await call(AbortSignal.timeout(boundMs));
  } catch (err) {
    throw new AuthUpstreamUnavailableError(`${what} unavailable: ${describe(err)}`, { cause: err });
  }
  if (isAuthUnavailableStatus(res.status)) {
    throw new AuthUpstreamUnavailableError(`${what} unavailable: ${res.status}`);
  }
  return res;
}

/** Reads a provider body. A stalled or cut-off body is an outage, not a verdict. */
export async function readAuthUpstreamJson(what: string, res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new AuthUpstreamUnavailableError(`${what} unavailable: unreadable body (${describe(err)})`, { cause: err });
  }
}

/**
 * For a route that charged an attempt budget BEFORE calling GoTrue: when, and
 * only when, the outcome is a classified outage, hand the charge back (no
 * password or code was judged, so it bounds no guess), then answer 503. A
 * failed refund is logged, never thrown: the 503 still goes out.
 */
export async function respondToAuthOutage(
  res: NextApiResponse, err: unknown, source: string, refund: () => Promise<unknown>,
): Promise<boolean> {
  if (!(err instanceof AuthUpstreamUnavailableError)) return false;
  try {
    await refund();
  } catch (refundErr) {
    log.warn(`${source}: refund after auth outage failed`, { message: describe(refundErr) }, 'Auth');
  }
  return respondIfAuthUnavailable(res, err, source);
}

/** Answers 503 + Retry-After when `err` is an outage. Never touches a cookie. */
export function respondIfAuthUnavailable(res: NextApiResponse, err: unknown, source: string): boolean {
  if (!(err instanceof AuthUpstreamUnavailableError)) return false;
  log.warn(`${source}: auth provider unavailable`, { message: err.message }, 'Auth');
  res.setHeader('Retry-After', String(AUTH_RETRY_AFTER_SECS));
  res.status(503).json({ success: false, error: { ...AUTH_UNAVAILABLE_ERROR } });
  return true;
}
