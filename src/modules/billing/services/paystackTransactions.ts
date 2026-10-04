/**
 * Paystack transactions: initialise, verify, charge authorization.
 * Re-exported from ./paystackClient.
 */

import { paystackFetch } from './paystackHttp';

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
  /** Abort the request after this long. Unset = no bound (the other callers' behaviour). */
  timeoutMs?: number;
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
    timeoutMs: input.timeoutMs,
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
  /** Paystack's `requested_amount`: the charge before a fee the customer paid. */
  requestedAmountCents: number | null;
  feesCents: number | null;
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
  requested_amount?: number | null;
  fees?: number | null;
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
  opts: { timeoutMs?: number } = {},
): Promise<VerifyTransactionResult> {
  const data = await paystackFetch<VerifyRaw>(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    { method: 'GET', timeoutMs: opts.timeoutMs },
  );
  return {
    status: mapStatus(data.status),
    reference: data.reference,
    id: data.id,
    amountCents: data.amount,
    requestedAmountCents: data.requested_amount ?? null,
    feesCents: data.fees ?? null,
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
