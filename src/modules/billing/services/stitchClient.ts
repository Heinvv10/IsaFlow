/**
 * Stitch Express API client (REST, not GraphQL).
 *
 * Stitch Express is the merchant-onboarded flavour of Stitch. It speaks
 * REST at https://express.stitch.money and exposes a narrow surface:
 * payment-links, payments, refunds, withdrawals, webhooks.
 *
 * Auth: OAuth2 client_credentials with raw client_id + client_secret.
 * Returns a short-lived (15 min) bearer token. We cache in-memory until
 * 60s before expiry.
 *
 * Subscription / card-consent endpoints exist but require extra sign-off
 * from express-support@stitch.money — they're not callable until Stitch
 * upgrades our tenant to the `client_recurringpaymentconsentrequest`
 * scope. Those helpers stay stubbed out until we get that access.
 */

import { log } from '@/lib/logger';

const STITCH_BASE_URL = 'https://express.stitch.money';
const TOKEN_PATH = '/api/v1/token';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Exported only for tests.
export function __resetTokenCacheForTests(): void {
  tokenCache = null;
}

// Stitch Express tokens are documented as 15 min TTL; response doesn't
// include expires_in, so we hardcode the refresh window.
const TOKEN_TTL_MS = 15 * 60 * 1000;

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - 60_000 > Date.now()) {
    return tokenCache.accessToken;
  }

  const clientId = requireEnv('STITCH_CLIENT_ID');
  const clientSecret = requireEnv('STITCH_CLIENT_SECRET');

  const res = await fetch(`${STITCH_BASE_URL}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });

  if (!res.ok) {
    const text = await res.text();
    log.error(
      'Stitch Express token request failed',
      { status: res.status, body: text.slice(0, 500) },
      'StitchClient',
    );
    throw new Error(`Stitch Express token request failed: ${res.status}`);
  }

  const json = (await res.json()) as {
    success: boolean;
    data?: { accessToken: string };
  };
  if (!json.success || !json.data?.accessToken) {
    throw new Error('Stitch Express token response missing accessToken');
  }
  tokenCache = {
    accessToken: json.data.accessToken,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  return json.data.accessToken;
}

async function stitchFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${STITCH_BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave parsed undefined — error path below will log the raw body
    }
  }

  if (!res.ok) {
    log.error(
      'Stitch Express request failed',
      { path, status: res.status, body: text.slice(0, 500) },
      'StitchClient',
    );
    const msg =
      (parsed as { message?: string; error?: string })?.message ??
      (parsed as { message?: string; error?: string })?.error ??
      `HTTP ${res.status}`;
    throw new Error(`Stitch Express ${path}: ${msg}`);
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// Payment links (once-off payins — the only flow live on Express today)
// ---------------------------------------------------------------------------

export interface CreatePaymentLinkInput {
  /** Amount in cents. */
  amountCents: number;
  currency?: 'ZAR';
  /** Required: the person/entity paying — shown on checkout UI. */
  payerName: string;
  /** Merchant-side reference (e.g. invoice number) — shown on checkout. */
  merchantReference: string;
  /** Optional correlation id — returned on status lookup + webhooks. */
  externalReference?: string;
  /** Absolute URL the payer's browser returns to after checkout. Must be
   *  whitelisted in Stitch Express dashboard → Redirect URLs. */
  redirectUrl?: string;
  description?: string;
  payerEmailAddress?: string;
  payerPhoneNumber?: string;
}

export interface CreatePaymentLinkResult {
  /** Stitch's payment link id — we persist this as stitch_payment_id. */
  id: string;
  /** Hosted checkout URL (Stitch returns this as `link`). */
  url: string;
  status: string;
}

interface PaymentLinkRaw {
  id: string;
  link: string;
  status: string;
  amount: number;
  merchantReference: string;
  payerName: string;
  paidAt: string | null;
  expireAt: string;
}

export async function createPaymentLink(
  input: CreatePaymentLinkInput,
): Promise<CreatePaymentLinkResult> {
  const wrapped = await stitchFetch<{
    success: boolean;
    data: { payment: PaymentLinkRaw };
  }>('/api/v1/payment-links', {
    method: 'POST',
    body: {
      amount: input.amountCents,
      currency: input.currency ?? 'ZAR',
      payerName: input.payerName,
      merchantReference: input.merchantReference,
      externalReference: input.externalReference,
      redirectUrl: input.redirectUrl,
      description: input.description,
      payerEmailAddress: input.payerEmailAddress,
      payerPhoneNumber: input.payerPhoneNumber,
    },
  });
  const p = wrapped.data.payment;
  return { id: p.id, url: p.link, status: p.status };
}

// ---------------------------------------------------------------------------
// Payment status lookup — used by the return-landing verify endpoint
// ---------------------------------------------------------------------------

export type StitchExpressPaymentStatus =
  | 'pending'
  | 'paid'
  | 'settled'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * Stitch Express payment status reads through `/api/v1/payment-links/{id}`.
 * The `/api/v1/payment/{id}` endpoint only returns a row once a payment
 * attempt has been made, so we start with the link endpoint.
 */
export async function getPaymentStatus(
  stitchId: string,
): Promise<{ status: StitchExpressPaymentStatus; raw: Record<string, unknown> }> {
  const wrapped = await stitchFetch<{
    success: boolean;
    data: { payment: PaymentLinkRaw };
  }>(`/api/v1/payment-links/${encodeURIComponent(stitchId)}`);
  const p = wrapped.data.payment;
  return { status: mapPaymentStatus(p.status), raw: p as unknown as Record<string, unknown> };
}

function mapPaymentStatus(raw: string): StitchExpressPaymentStatus {
  const s = (raw || '').toLowerCase();
  if (['paid', 'completed', 'complete'].includes(s)) return 'paid';
  if (['settled', 'settlement', 'received'].includes(s)) return 'settled';
  if (['failed', 'declined'].includes(s)) return 'failed';
  if (['cancelled', 'canceled', 'closed'].includes(s)) return 'cancelled';
  if (['expired', 'timedout'].includes(s)) return 'expired';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Recurring / mandate helpers — NOT AVAILABLE on vanilla Stitch Express.
// Stubbed so the subscription billing service compiles but fails fast.
// Re-enable when Stitch upgrades the tenant to `client_recurringpaymentconsentrequest`.
// ---------------------------------------------------------------------------

const RECURRING_DISABLED_MSG =
  'Stitch Express recurring / card-consent endpoints not enabled on this tenant. ' +
  'Email express-support@stitch.money to request access.';

export interface DebitFromMandateInput {
  bankAccountId: string;
  amountCents: number;
  currency?: 'ZAR';
  payerReference: string;
  beneficiaryReference: string;
  externalReference: string;
}

export async function debitFromMandate(
  _input: DebitFromMandateInput,
): Promise<never> {
  throw new Error(RECURRING_DISABLED_MSG);
}
