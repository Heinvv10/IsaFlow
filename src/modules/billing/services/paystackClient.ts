/**
 * Paystack REST client.
 *
 * Auth: Bearer token using PAYSTACK_SECRET_KEY (sk_test_/sk_live_).
 * Currency: ZAR. Amounts on the wire are in cents (smallest unit) — same
 * unit we already store in BIGINT cents columns.
 *
 * Endpoints used:
 *   POST /transaction/initialize          — start a hosted checkout
 *   GET  /transaction/verify/:reference   — verify final status
 *   POST /transaction/charge_authorization — recurring debit on an authorization
 *   POST /plan                            — create a plan (one per pricing tier)
 *   POST /subscription                    — start a subscription on an authorization
 *   POST /subscription/disable            — cancel a subscription
 *
 * Webhook signature verification lives in pages/api/webhooks/paystack.ts.
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

async function paystackFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
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

// ---------------------------------------------------------------------------
// Transaction initialise — once-off hosted checkout (invoices, top-ups, auth)
// ---------------------------------------------------------------------------

export interface InitializeTransactionInput {
  email: string;
  /** Amount in cents (ZAR smallest unit). */
  amountCents: number;
  /** Our correlation id. Paystack echoes this back on verify + webhook. */
  reference: string;
  currency?: 'ZAR';
  /** Absolute URL the payer's browser returns to after checkout. */
  callbackUrl?: string;
  /** Free-form metadata stored on the transaction. */
  metadata?: Record<string, unknown>;
  /**
   * Restrict the channels offered on checkout. Default = all enabled on the
   * Paystack dashboard. Useful for forcing eft / bank-only.
   */
  channels?: Array<'card' | 'bank' | 'ussd' | 'qr' | 'mobile_money' | 'bank_transfer' | 'eft'>;
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

interface InitializeRaw {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export async function initializeTransaction(
  input: InitializeTransactionInput,
): Promise<InitializeTransactionResult> {
  const data = await paystackFetch<InitializeRaw>('/transaction/initialize', {
    method: 'POST',
    body: {
      email: input.email,
      amount: input.amountCents,
      reference: input.reference,
      currency: input.currency ?? 'ZAR',
      callback_url: input.callbackUrl,
      metadata: input.metadata,
      channels: input.channels,
    },
  });
  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference,
  };
}

// ---------------------------------------------------------------------------
// Transaction verify — resolve final state by reference
// ---------------------------------------------------------------------------

export type PaystackTransactionStatus =
  | 'success'
  | 'failed'
  | 'abandoned'
  | 'pending'
  | 'reversed';

export interface VerifyTransactionResult {
  status: PaystackTransactionStatus;
  reference: string;
  /** Numeric Paystack transaction id. */
  id: number;
  amountCents: number;
  currency: string;
  channel: string | null;
  paidAt: string | null;
  gatewayResponse: string | null;
  customer: {
    email: string;
    customerCode: string;
  } | null;
  authorization: {
    authorizationCode: string;
    bin: string | null;
    last4: string | null;
    expMonth: string | null;
    expYear: string | null;
    cardType: string | null;
    bank: string | null;
    brand: string | null;
    reusable: boolean;
  } | null;
}

interface VerifyRaw {
  status: string;
  reference: string;
  id: number;
  amount: number;
  currency: string;
  channel: string | null;
  paid_at: string | null;
  gateway_response: string | null;
  customer: {
    email: string;
    customer_code: string;
  } | null;
  authorization: {
    authorization_code: string;
    bin: string | null;
    last4: string | null;
    exp_month: string | null;
    exp_year: string | null;
    card_type: string | null;
    bank: string | null;
    brand: string | null;
    reusable: boolean;
  } | null;
}

export async function verifyTransaction(
  reference: string,
): Promise<VerifyTransactionResult> {
  const data = await paystackFetch<VerifyRaw>(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    { method: 'GET' },
  );
  return {
    status: mapStatus(data.status),
    reference: data.reference,
    id: data.id,
    amountCents: data.amount,
    currency: data.currency,
    channel: data.channel,
    paidAt: data.paid_at,
    gatewayResponse: data.gateway_response,
    customer: data.customer
      ? {
          email: data.customer.email,
          customerCode: data.customer.customer_code,
        }
      : null,
    authorization: data.authorization
      ? {
          authorizationCode: data.authorization.authorization_code,
          bin: data.authorization.bin,
          last4: data.authorization.last4,
          expMonth: data.authorization.exp_month,
          expYear: data.authorization.exp_year,
          cardType: data.authorization.card_type,
          bank: data.authorization.bank,
          brand: data.authorization.brand,
          reusable: data.authorization.reusable,
        }
      : null,
  };
}

function mapStatus(raw: string): PaystackTransactionStatus {
  const s = (raw || '').toLowerCase();
  if (s === 'success') return 'success';
  if (s === 'failed') return 'failed';
  if (s === 'abandoned') return 'abandoned';
  if (s === 'reversed') return 'reversed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Charge authorization — recurring debit using a stored authorization_code
// ---------------------------------------------------------------------------

export interface ChargeAuthorizationInput {
  authorizationCode: string;
  email: string;
  amountCents: number;
  reference: string;
  currency?: 'ZAR';
  metadata?: Record<string, unknown>;
}

interface ChargeAuthRaw {
  status: string;
  reference: string;
  id?: number;
  amount: number;
  gateway_response?: string;
}

export interface ChargeAuthorizationResult {
  status: PaystackTransactionStatus;
  reference: string;
  paystackId: number | null;
  amountCents: number;
  gatewayResponse: string | null;
}

export async function chargeAuthorization(
  input: ChargeAuthorizationInput,
): Promise<ChargeAuthorizationResult> {
  const data = await paystackFetch<ChargeAuthRaw>(
    '/transaction/charge_authorization',
    {
      method: 'POST',
      body: {
        authorization_code: input.authorizationCode,
        email: input.email,
        amount: input.amountCents,
        reference: input.reference,
        currency: input.currency ?? 'ZAR',
        metadata: input.metadata,
      },
    },
  );
  return {
    status: mapStatus(data.status),
    reference: data.reference,
    paystackId: data.id ?? null,
    amountCents: data.amount,
    gatewayResponse: data.gateway_response ?? null,
  };
}

// ---------------------------------------------------------------------------
// Plans + subscriptions — server-driven recurring billing
// ---------------------------------------------------------------------------

export interface CreatePlanInput {
  name: string;
  amountCents: number;
  interval: 'monthly' | 'annually' | 'weekly' | 'daily' | 'biannually' | 'quarterly';
  currency?: 'ZAR';
  description?: string;
}

export interface PlanResult {
  id: number;
  planCode: string;
  name: string;
  amountCents: number;
  interval: string;
}

interface PlanRaw {
  id: number;
  plan_code: string;
  name: string;
  amount: number;
  interval: string;
}

export async function createPlan(input: CreatePlanInput): Promise<PlanResult> {
  const data = await paystackFetch<PlanRaw>('/plan', {
    method: 'POST',
    body: {
      name: input.name,
      amount: input.amountCents,
      interval: input.interval,
      currency: input.currency ?? 'ZAR',
      description: input.description,
    },
  });
  return {
    id: data.id,
    planCode: data.plan_code,
    name: data.name,
    amountCents: data.amount,
    interval: data.interval,
  };
}

export interface CreateSubscriptionInput {
  /** Either a customer email or a CUS_ code. */
  customer: string;
  /** PLN_ code from createPlan. */
  planCode: string;
  /** Optional: pin to a specific authorization (else most recent). */
  authorizationCode?: string;
  /** ISO 8601 date for the first debit. */
  startDate?: string;
}

export interface SubscriptionResult {
  id: number;
  subscriptionCode: string;
  emailToken: string;
  status: string;
  amountCents: number;
}

interface SubscriptionRaw {
  id: number;
  subscription_code: string;
  email_token: string;
  status: string;
  amount: number;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<SubscriptionResult> {
  const data = await paystackFetch<SubscriptionRaw>('/subscription', {
    method: 'POST',
    body: {
      customer: input.customer,
      plan: input.planCode,
      authorization: input.authorizationCode,
      start_date: input.startDate,
    },
  });
  return {
    id: data.id,
    subscriptionCode: data.subscription_code,
    emailToken: data.email_token,
    status: data.status,
    amountCents: data.amount,
  };
}

export interface DisableSubscriptionInput {
  subscriptionCode: string;
  emailToken: string;
}

export async function disableSubscription(
  input: DisableSubscriptionInput,
): Promise<void> {
  await paystackFetch<unknown>('/subscription/disable', {
    method: 'POST',
    body: {
      code: input.subscriptionCode,
      token: input.emailToken,
    },
  });
}
