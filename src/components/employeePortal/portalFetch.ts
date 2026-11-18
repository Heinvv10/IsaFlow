/**
 * The employee portal's client calls (wave 6 SS). Plain fetch, never apiFetch: apiFetch answers a 401 by renewing the
 * STAFF session and sending the browser to the staff /login. Here a 401 means the portal session ended.
 */
import { ApiRequestError } from '@/lib/apiFetch';

type ErrorBody = { error?: { message?: string; details?: Record<string, unknown> } } | null;

/** An ApiRequestError, so a page shows it with apiErrorMessage; `reason` and `details` are the refusal's. */
export class PortalCallError extends ApiRequestError {
  constructor(message: string, status: number, readonly reason?: string, readonly details?: Record<string, unknown>) {
    super(message, status);
    this.name = 'PortalCallError';
  }
}

/** `failure` is the plain sentence shown when the server sends no message of its own. */
export async function portalCall<T>(url: string, failure: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(url, init ? {
    method: init.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body), credentials: 'same-origin',
  } : { credentials: 'same-origin' });
  if (!res.ok) {
    const failed = (await res.json().catch(() => null)) as ErrorBody;
    const details = failed?.error?.details;
    throw new PortalCallError(failed?.error?.message ?? failure, res.status, typeof details?.reason === 'string' ? details.reason : undefined, details);
  }
  const json = (await res.json().catch(() => null)) as { data?: T } | null;
  return json?.data as T;
}
