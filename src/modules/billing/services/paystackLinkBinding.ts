/**
 * Does a Paystack payment belong to the billing row its payment request names?
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
  flow_purchase_id: string | null;
  subscription_charge_id: string | null;
  mandate_id: string | null;
}

const LINK_KEY: Record<string, keyof PaymentLink | undefined> = {
  flow_bundle: 'flow_purchase_id',
  subscription_charge: 'subscription_charge_id',
  authorization: 'mandate_id',
};

/**
 * Null when the payment's metadata names this request's company and, for a
 * billing purpose, the same purchase, charge or mandate; otherwise why not. A
 * pre-651 mandate checkout has no mandate_id on its row, so only its company is
 * compared (activation then resolves the company's own pending mandate).
 */
export function linkMismatch(pr: PaymentLink, metadata: Record<string, unknown> | null | undefined): string | null {
  const key = LINK_KEY[pr.purpose];
  if (!key) return null;
  if (!metadata || typeof metadata !== 'object') return 'no_checkout_metadata';
  if (metadata.company_id !== pr.company_id) return 'checkout_company_mismatch';
  const linked = pr[key];
  if (linked !== null && metadata[key] !== linked) return `checkout_${key}_mismatch`;
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
