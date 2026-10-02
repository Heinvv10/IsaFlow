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
}

const positiveCents = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

export const isBookCurrency = (reported: ReportedCharge): boolean => reported.currency === BOOK_CURRENCY;

/**
 * The cents to bank and the reasons it needs review.
 *
 * `requested_amount` when Paystack reports one: the rest of `amount` is a fee the
 * customer paid, which is the gateway's money, not customer credit. Otherwise
 * `amount`. A missing or malformed amount falls back to the request (what Paystack
 * was asked to charge) and is flagged: refusing would make every webhook
 * redelivery fail. An `amount` below `requested_amount` makes the latter
 * untrustworthy, so the amount is banked and both are flagged.
 */
export function settledCharge(
  requestedCents: number,
  reported: ReportedCharge,
): { cents: number; reviews: string[] } {
  const reviews: string[] = [];
  const amount = positiveCents(reported.amountCents);
  let requestedAmount = positiveCents(reported.requestedAmountCents);
  if (requestedAmount !== null && amount !== null && amount < requestedAmount) requestedAmount = null;
  const cents = requestedAmount ?? amount;
  if (cents === null) reviews.push('amount_not_reported');
  else if (cents !== requestedCents) reviews.push('amount_mismatch');
  if (positiveCents(reported.requestedAmountCents) !== null && requestedAmount === null) {
    reviews.push('amount_below_requested_amount');
  }
  if (!isBookCurrency(reported)) reviews.push('currency_mismatch');
  return { cents: cents ?? requestedCents, reviews };
}

/**
 * The part of the gateway's fee the MERCHANT bore, in rand: the fee less what the
 * customer paid on top of `requested_amount`. The receipt is banked at
 * requested_amount, so Bank nets to `amount - fees`, which is what Paystack
 * settles. A non-ZAR fee is not posted as rand: it is flagged instead.
 */
export function merchantFee(
  feeRand: number | null | undefined,
  reported: ReportedCharge,
): { feeRand: number | null; reviews: string[] } {
  const fee = Number(feeRand ?? 0);
  if (!Number.isFinite(fee) || fee <= 0) return { feeRand: null, reviews: [] };
  if (!isBookCurrency(reported)) return { feeRand: null, reviews: ['fee_not_posted_currency'] };
  const amount = positiveCents(reported.amountCents);
  const requestedAmount = positiveCents(reported.requestedAmountCents);
  const customerPaid = amount !== null && requestedAmount !== null && amount >= requestedAmount
    ? (amount - requestedAmount) / 100 : 0;
  return { feeRand: Math.max(0, Math.round((fee - customerPaid) * 100) / 100), reviews: [] };
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
  if (previous === null) return `review:${reviews.join(',')}`;
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
