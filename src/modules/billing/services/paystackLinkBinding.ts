/**
 * Does a Paystack payment belong to the billing row (or invoice) its payment
 * request names?
 *
 * `paystack_payment_requests` is the link between a payment and what it pays
 * for (a Flow purchase, a subscription charge, a mandate), and its rows are
 * written on the app pools. Its link columns are no longer app-writable after
 * insert (migration 945), but the webhook and mandate verify act on that link
 * on migration_admin, which bypasses row security (S-07e). So before acting,
 * each checks the link against what Paystack itself carries: the metadata the
 * checkout was started with (set server-side from the verified request, and
 * signed by Paystack on the webhook) and the amount it asked for.
 */
import { log } from '@/lib/logger';

/** The payment request columns a binding judges. */
export interface PaymentLink {
  company_id: string;
  purpose: string;
  flow_purchase_id?: string | null;
  subscription_charge_id?: string | null;
  mandate_id?: string | null;
  customer_invoice_id?: string | null;
}

/** Per purpose: the request's link column, and the metadata key its checkout carries it under. */
const LINK: Record<string, [keyof PaymentLink, string]> = {
  flow_bundle: ['flow_purchase_id', 'flow_purchase_id'],
  subscription_charge: ['subscription_charge_id', 'subscription_charge_id'],
  authorization: ['mandate_id', 'mandate_id'],
  customer_invoice: ['customer_invoice_id', 'invoice_id'],
};

/**
 * Null when the payment's metadata names this request's company and the same
 * purchase, charge, mandate or invoice; otherwise why not. A request with no
 * link (a pre-651 mandate checkout, whose activation used to fall back to "the
 * company's pending mandate") binds to nothing: anyone can start a Paystack
 * checkout with any metadata, so a company match alone proves nothing.
 */
export function linkMismatch(pr: PaymentLink, metadata: Record<string, unknown> | null | undefined): string | null {
  const link = LINK[pr.purpose];
  if (!link) return 'unknown_purpose';
  const [column, key] = link;
  if (!metadata || typeof metadata !== 'object') return 'no_checkout_metadata';
  if (metadata.company_id !== pr.company_id) return 'checkout_company_mismatch';
  const linked = pr[column];
  if (!linked) return `no_${column}`;
  if (metadata[key] !== linked) return `checkout_${column}_mismatch`;
  return null;
}

/**
 * What the checkout asked for, in cents: `requested_amount` (Paystack adds a fee
 * the payer bears on top of it in `amount`), else `amount`. Null when neither
 * is a finite number, which binds to nothing.
 */
export function requestedCents(data: { requested_amount?: unknown; amount?: unknown }): number | null {
  const raw = data.requested_amount ?? data.amount;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Logged at error level: money moved, and the billing row it named was left alone. */
export function logRefusedLink(reference: string, pr: PaymentLink & { id: string }, reason: string): void {
  log.error('Paystack payment does not match the billing row its request names; nothing credited, settled or activated', {
    reference, paymentRequestId: pr.id, companyId: pr.company_id, purpose: pr.purpose, reason,
  }, 'PaystackWebhook');
}
