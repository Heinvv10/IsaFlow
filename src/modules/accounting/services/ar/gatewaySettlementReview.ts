/**
 * What a gateway settlement banks, and when it needs a person to look at it (R-181).
 *
 * The webhook and the return page's verify route both settle through
 * `recordGatewayInvoiceReceipt`, and both used to bank the request's stored
 * `amount_cents` whatever Paystack said it received. The money in the bank is
 * what Paystack received, so that is what is banked now (Hein, 2026-10-02); a
 * difference from the request, or a currency other than the books', is not
 * refused but flagged.
 *
 * The flag is `paystack_payment_requests.failure_reason = 'review:<reasons>'`
 * on the completed request: the same column `noteAuthorisationNotAttached`
 * writes when a card was charged and nothing could be attached. The receipt is
 * found from it by `customer_payments.bank_reference = paystack_reference`.
 * Hein approved this column over a migration on 2026-10-02.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { documentInPopulation } from '../shared/documentPopulation';

/** The currency the books are kept in; Paystack reports ISO codes. */
const BOOK_CURRENCY = 'ZAR';
const PREVIOUSLY = ' | previously: ';

/** What the gateway reported for the charge, unvalidated (a webhook body or a verify response). */
export interface ReportedCharge {
  amountCents?: unknown;
  currency?: unknown;
  /**
   * Paystack's `requested_amount`: the charge before a fee the CUSTOMER paid. On an
   * account that passes charges to the customer, `amount` = requested_amount + fee.
   */
  requestedAmountCents?: unknown;
  /** Paystack's `fees` in cents: what bounds a customer-paid excess. Null when not reported. */
  feeCents?: unknown;
}

const positiveCents = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const nonNegativeCents = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

export const isBookCurrency = (reported: ReportedCharge): boolean => reported.currency === BOOK_CURRENCY;

/**
 * Why `requested_amount` may not be banked in place of `amount`, or null when it may.
 * It may only when the excess `amount - requested_amount` is a fee the customer paid:
 * 0 <= excess <= fees. Anything else banks `amount`, and the fee leg then makes Bank
 * net to `amount - fees`, what Paystack settles. With no fee figure (a verify response
 * without one) the excess cannot be bounded, so `amount` is banked and the later
 * webhook's fee leg brings Bank to the settlement (fix.md, review round 2).
 */
function requestedAmountDistrust(amount: number, requestedAmount: number, fee: number | null): string | null {
  if (amount < requestedAmount) return 'amount_below_requested_amount';
  if (amount === requestedAmount) return null;
  if (fee === null) return 'requested_amount_unverified';
  return amount - requestedAmount > fee ? 'requested_amount_exceeds_fee' : null;
}

/**
 * The cents to bank and the reasons it needs review.
 *
 * `requested_amount` when Paystack reports one it can be trusted for (see
 * requestedAmountDistrust): the rest of `amount` is a fee the customer paid, the
 * gateway's money, not customer credit. Otherwise `amount`. A missing or malformed
 * amount is flagged even when `requested_amount` is present (which is then banked),
 * and with neither the request (what Paystack was asked to charge) is banked:
 * refusing would make every webhook redelivery fail.
 */
export function settledCharge(
  requestedCents: number,
  reported: ReportedCharge,
): { cents: number; reviews: string[] } {
  const amount = positiveCents(reported.amountCents);
  const requestedAmount = positiveCents(reported.requestedAmountCents);
  const distrust = amount !== null && requestedAmount !== null
    ? requestedAmountDistrust(amount, requestedAmount, nonNegativeCents(reported.feeCents)) : null;
  const cents = (distrust === null ? requestedAmount : null) ?? amount ?? requestedCents;
  const reviews: string[] = [];
  if (amount === null) reviews.push('amount_not_reported');
  if (cents !== requestedCents) reviews.push('amount_mismatch');
  if (distrust) reviews.push(distrust);
  if (!isBookCurrency(reported)) reviews.push('currency_mismatch');
  return { cents, reviews };
}

/**
 * The fee leg to post, in rand: `fees - (amount - banked)`, clamped to [0, fees],
 * so that Bank nets to `amount - fees`, what Paystack deposits. `bankedCents` is the
 * receipt as booked — on a second report, what the FIRST one banked. With charges
 * passed to the customer and the receipt at requested_amount, `amount - banked` is
 * the fee the customer paid. A clamp that bites means Bank cannot reach the deposit
 * (or would need more than the reported fee): it is flagged, never booked as a fee.
 * The leg is also capped at the receipt (`fee_exceeds_receipt`).
 * A non-ZAR fee is not posted as rand: it is flagged instead.
 */
export function merchantFee(
  feeRand: number | null | undefined,
  reported: ReportedCharge,
  bankedCents: number,
): { feeRand: number | null; reviews: string[] } {
  const fee = Number(feeRand ?? 0);
  if (!Number.isFinite(fee) || fee <= 0) return { feeRand: null, reviews: [] };
  if (!isBookCurrency(reported)) return { feeRand: null, reviews: ['fee_not_posted_currency'] };
  const amount = positiveCents(reported.amountCents);
  const raw = fee - (amount === null ? 0 : (amount - bankedCents) / 100);
  // Compared in whole cents: float rand differences miss a cent.
  const rawCents = Math.round(raw * 100);
  const clampedCents = Math.min(Math.round(fee * 100), Math.max(0, rawCents));
  // Never more than the receipt itself: a fee above it would drive Bank below zero for the charge.
  const posted = Math.min(clampedCents, bankedCents) / 100;
  const reviews = [
    ...(clampedCents !== rawCents ? ['fee_clamped'] : []),
    ...(clampedCents > bankedCents ? ['fee_exceeds_receipt'] : []),
  ];
  return { feeRand: posted, reviews };
}

const AMOUNT_TAG = /\[paystack amount (\d+) cents\]/;

/**
 * The receipt's description. It names a non-ZAR currency, and tags Paystack's
 * `amount` when it differs from what is banked, so a second report can compare
 * its `amount` with the first's without a column for it.
 */
export function receiptDescription(reference: string, reported: ReportedCharge, bankedCents: number): string {
  const amount = positiveCents(reported.amountCents);
  const parts = [`Paystack card payment ${reference}`];
  if (!isBookCurrency(reported)) {
    parts.push(`(${String(reported.currency)} ${(bankedCents / 100).toFixed(2)} reported, booked as ZAR)`);
  }
  if (amount !== null && amount !== bankedCents) parts.push(`[paystack amount ${amount} cents]`);
  return parts.join(' ');
}

const CURRENCY_TAG = /\(([A-Z]{3}) [\d.]+ reported, booked as ZAR\)/;

/** The currency a receipt was reported in: its non-ZAR tag (receiptDescription), else ZAR. */
export function receiptCurrency(description: string | null): string {
  const tag = description ? CURRENCY_TAG.exec(description) : null;
  return tag ? tag[1]! : 'ZAR';
}

/** The first report's Paystack `amount`: its tag, else what it banked. */
export function firstReportedAmountCents(description: string | null, bankedCents: number): number {
  const tag = description ? AMOUNT_TAG.exec(description) : null;
  return tag ? Number(tag[1]) : bankedCents;
}

/**
 * Why the invoice may not take the money, or null when it may. Outside the
 * ledger means a draft, pending approval or cancelled (`documentInPopulation`),
 * or soft-deleted: allocating to one settles a balance the ledger never carried.
 */
export function invoiceReview(status: string | null, deletedAt: string | null): string | null {
  if (deletedAt) return 'invoice_deleted';
  if (!documentInPopulation(status)) return `invoice_${status}`;
  return null;
}

/**
 * The note to store: the new reasons merged into an earlier review note (a second
 * report adds to the first, never erases it), and any other reason the request
 * already carried kept after it.
 */
export function composeReviewNote(previous: string | null, reviews: string[]): string {
  if (!previous) return `review:${reviews.join(',')}`;
  if (!previous.startsWith('review:')) return `review:${reviews.join(',')}${PREVIOUSLY}${previous}`;
  const cut = previous.indexOf(PREVIOUSLY);
  const head = cut < 0 ? previous : previous.slice(0, cut);
  const tail = cut < 0 ? '' : previous.slice(cut);
  const merged = [...new Set([...head.slice('review:'.length).split(',').filter(Boolean), ...reviews])];
  return `review:${merged.join(',')}${tail}`;
}

/**
 * Flag the completed request for review and say so at error level. Tenant-scoped.
 *
 * The note is bookkeeping about money already banked, so it must never cost the
 * receipt: the write runs in its own savepoint and a failure is logged, not
 * thrown. Outside a savepoint a failed UPDATE aborts the settlement transaction
 * and the webhook's next statement rolls the whole receipt back.
 */
export async function flagSettlementForReview(
  companyId: string,
  reference: string,
  reviews: string[],
  detail: Record<string, unknown>,
): Promise<void> {
  let previousFailureReason: string | null = null;
  try {
    previousFailureReason = await withSavepoint('gateway_review_note', async () => {
      const rows = await sql<{ failure_reason: string | null }>`
        SELECT failure_reason FROM paystack_payment_requests
        WHERE company_id = ${companyId}::UUID AND paystack_reference = ${reference}
        FOR UPDATE
      `;
      const previous = rows[0]?.failure_reason ?? null;
      await sql`
        UPDATE paystack_payment_requests
        SET failure_reason = ${composeReviewNote(previous, reviews)}
        WHERE company_id = ${companyId}::UUID AND paystack_reference = ${reference}
      `;
      return previous;
    });
  } catch (err) {
    log.error(
      'Gateway settlement review note could not be written; the receipt stands',
      { companyId, reference, reviews, error: err instanceof Error ? err.message : String(err) },
      'accounting',
    );
  }
  log.error(
    'Gateway settlement needs review',
    { companyId, reference, reviews, previousFailureReason, ...detail },
    'accounting',
  );
}
