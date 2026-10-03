/**
 * Paystack REST client — shared request core (base URL, env, fetch wrapper).
 * The single instance every Paystack endpoint module imports. `paystackFetch` is internal
 * to the Paystack modules and is NOT re-exported by ./paystackClient (the public
 * surface is exactly what the barrel re-exports from the endpoint modules).
 */

import { log } from '@/lib/logger';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Free-form label tagged on every Paystack log line. Lets us tell which
 *  integration handled an event when one Paystack login serves multiple
 *  apps (ISAFlow + ApexGEO etc). */
function integrationName(): string {
  return process.env.PAYSTACK_INTEGRATION_NAME?.trim() || 'unset';
}

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export async function paystackFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = { method: 'GET' },
): Promise<T> {
  const secret = requireEnv('PAYSTACK_SECRET_KEY');
  const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    ...(init.timeoutMs !== undefined && { signal: AbortSignal.timeout(init.timeoutMs) }),
  });

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave undefined — error path below logs raw body
    }
  }

  if (!res.ok) {
    const msg =
      (parsed as { message?: string })?.message ?? `HTTP ${res.status}`;
    log.error(
      'Paystack request failed',
      { integration: integrationName(), path, status: res.status, body: text.slice(0, 500) },
      'PaystackClient',
    );
    throw new Error(`Paystack ${path}: ${msg}`);
  }

  const wrapped = parsed as PaystackResponse<T> | undefined;
  if (!wrapped || wrapped.status !== true) {
    throw new Error(
      `Paystack ${path}: ${wrapped?.message ?? 'unknown error'}`,
    );
  }
  return wrapped.data;
}
