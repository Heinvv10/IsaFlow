/**
 * The employee portal's client calls (wave 6 SS). Plain fetch, never apiFetch: apiFetch answers a 401 by renewing the
 * STAFF session and sending the browser to the staff /login. Here a 401 means the portal session ended.
 */
export class PortalCallError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'PortalCallError';
  }
}

export async function portalCall<T>(url: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(url, init ? {
    method: init.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body), credentials: 'same-origin',
  } : { credentials: 'same-origin' });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; details?: Record<string, unknown> } } | null;
  if (!res.ok) {
    const details = json?.error?.details;
    throw new PortalCallError(json?.error?.message ?? 'Something went wrong. Please try again.', res.status,
      typeof details?.reason === 'string' ? details.reason : undefined, details);
  }
  return json?.data as T;
}
