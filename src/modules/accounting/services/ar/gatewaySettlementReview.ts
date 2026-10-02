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
 * on the completed request: the same marker `noteAuthorisationNotAttached`
 * leaves when a card was charged and nothing could be attached. The receipt is
 * found from it by `customer_payments.bank_reference = paystack_reference`.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { documentInPopulation } from '../shared/documentPopulation';

/** The currency the books are kept in; Paystack reports ISO codes. */
const BOOK_CURRENCY = 'ZAR';

/** What the gateway reported for the charge, unvalidated (a webhook body or a verify response). */
export interface ReportedCharge {
  amountCents?: unknown;
  currency?: unknown;
}

/**
 * The cents to bank and the reasons it needs review. A missing or malformed
 * reported amount falls back to the request's (what Paystack was asked to
 * charge) and is flagged: refusing would make every webhook redelivery fail.
 */
export function settledCharge(
  requestedCents: number,
  reported: ReportedCharge,
): { cents: number; reviews: string[] } {
  const reviews: string[] = [];
  const amount = reported.amountCents;
  const known = typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0;
  if (!known) reviews.push('amount_not_reported');
  else if (amount !== requestedCents) reviews.push('amount_mismatch');
  if (reported.currency !== BOOK_CURRENCY) reviews.push('currency_mismatch');
  return { cents: known ? amount : requestedCents, reviews };
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

/** Flag the completed request for review and say so at error level. Tenant-scoped. */
export async function flagSettlementForReview(
  companyId: string,
  reference: string,
  reviews: string[],
  detail: Record<string, unknown>,
): Promise<void> {
  await sql`
    UPDATE paystack_payment_requests
    SET failure_reason = ${`review:${reviews.join(',')}`}
    WHERE company_id = ${companyId}::UUID AND paystack_reference = ${reference}
  `;
  log.error(
    'Gateway settlement needs review',
    { companyId, reference, reviews, ...detail },
    'accounting',
  );
}
