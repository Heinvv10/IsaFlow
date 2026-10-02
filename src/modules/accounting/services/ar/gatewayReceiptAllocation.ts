/**
 * How much of a gateway receipt its invoice takes (R-181 review round 1).
 *
 * The decision is made under a row lock on the invoice. Read unlocked, two
 * settlements for one invoice (two Paystack references, or a manual receipt at
 * the same moment) both saw the full balance and both allocated it, and
 * `confirmCustomerPayment` adds to `amount_paid` with no cap; an invoice
 * cancelled mid-flight still took its allocation.
 *
 * LOCK ORDER of a settlement (ar/.claude.md, R-181): the request row (the webhook
 * and verify UPDATE it), then an explicit-amount `portal_payment_links` row
 * (`spendPaymentLinkOfRequest`), then the receipt's own new `customer_payments`
 * row, then this invoice. `customerMergeService` takes invoice then link, the
 * opposite, so a merge racing the settlement of the same customer's
 * explicit-amount link can raise 40P01 (pre-existing; recoverable). A 55P03 after
 * 5s becomes `CustomerInvoiceLockTimeoutError` and rolls the settlement back, so
 * nothing is lost: the webhook answers 500 and Paystack redelivers; verify answers
 * `pending` and leaves the request as stored for the webhook. The DEDUPE path
 * (receipt already banked) never reaches here: spend link, then fee journal, then
 * the request row FOR UPDATE last (the review note), with no lock_timeout and no
 * cycle, because the request is already completed.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withCustomerInvoiceLock } from './customerInvoiceLock';
import { invoiceReview } from './gatewaySettlementReview';


export interface GatewayAllocation {
  allocated: number;
  /**
   * Why the invoice takes none of it: `invoice_<status>` / `invoice_deleted` when the
   * invoice is outside the ledger, or the caller's own hold (`unapplied_currency`).
   */
  invoiceBlock: string | null;
  /** The invoice's customer as read under the lock: a merge may have moved it since. */
  clientId: string | null;
  /** Banked but neither allocated nor blocked: the customer is owed a refund or a placement. */
  overpaid: boolean;
  status: string | null;
  deleted: boolean;
}

/** The invoice row as read under the lock, plus what the caller decides. */
export interface AllocationInputs {
  totalAmount: string;
  amountPaid: string | null;
  /** Draft receipts' open allocations against the invoice. */
  pending: number;
  amountRand: number;
  status: string | null;
  deletedAt: string | null;
  hold: string | null;
}

/** The pure arithmetic of the allocation (unit-tested; the DB read is decideGatewayAllocation's). */
export function allocationPlan(inputs: AllocationInputs): Pick<GatewayAllocation, 'allocated' | 'invoiceBlock' | 'overpaid'> {
  // In whole cents: a float rand difference misses a cent (2.01 - 2.00 > 0.01 is false).
  const cents = (rand: number) => Math.round(rand * 100);
  const amountCents = cents(inputs.amountRand);
  // The gateway can settle more than the invoice still owes — an EFT part-payment
  // landing between the payment link and the card charge is enough. The excess is
  // real cash in the bank, so the receipt is banked in full and only the part the
  // invoice can absorb is allocated; the remainder stays on the customer as an
  // unapplied receipt. Truncating the receipt to fit would drop that cash.
  const outstanding = cents(Number(inputs.totalAmount)) - cents(Number(inputs.amountPaid ?? 0)) - cents(inputs.pending);
  // An invoice outside the ledger takes none of it: the whole receipt stays on the
  // customer unapplied, for a person to place. So does one whose balance is not a
  // number (numeric NaN in total_amount or amount_paid is a real state, R-166).
  const invoiceBlock = invoiceReview(inputs.status, inputs.deletedAt) ?? inputs.hold
    ?? (Number.isFinite(outstanding) ? null : 'invoice_balance_invalid');
  const allocatedCents = invoiceBlock ? 0 : Math.max(0, Math.min(amountCents, outstanding));
  return { allocated: allocatedCents / 100, invoiceBlock, overpaid: !invoiceBlock && amountCents > allocatedCents };
}

export async function decideGatewayAllocation(
  companyId: string,
  invoiceId: string,
  amountRand: number,
  reference: string,
  hold: string | null = null,
): Promise<GatewayAllocation> {
  const locked = await withCustomerInvoiceLock('recordGatewayInvoiceReceipt', `Invoice ${invoiceId}`, () => sql<{
    locked_total: string; amount_paid: string | null; status: string | null; deleted_at: string | null;
    client_id: string | null;
  }>`
    SELECT total_amount::text AS locked_total, amount_paid::text AS amount_paid,
           status, deleted_at::text AS deleted_at,
           COALESCE(client_id, customer_id)::text AS client_id
    FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `);
  const invoice = locked[0];
  if (!invoice) throw new Error(`Gateway receipt: invoice ${invoiceId} not found for company ${companyId}`);

  // `amount_paid` counts CONFIRMED payments only. Draft receipts an accountant
  // has open already claim part of the balance, and confirming both would drive
  // amount_paid past total_amount — the W3/P2.1 invariant createCustomerPayment
  // enforces, which has to be carried here now that it is not called.
  const pendingRows = await sql<{ pending: string }>`
    SELECT COALESCE(SUM(cpa.amount_allocated), 0)::text AS pending
    FROM customer_payment_allocations cpa
    JOIN customer_payments cp ON cp.id = cpa.payment_id
    WHERE cpa.invoice_id = ${invoiceId}::UUID
      AND cp.company_id = ${companyId}::UUID
      AND cp.status = 'draft'
  `;
  const pending = Number(pendingRows[0]?.pending ?? 0);

  const { allocated, invoiceBlock, overpaid } = allocationPlan({
    totalAmount: invoice.locked_total, amountPaid: invoice.amount_paid, pending, amountRand,
    status: invoice.status, deletedAt: invoice.deleted_at, hold,
  });
  if (overpaid) {
    log.warn(
      'Gateway receipt exceeds the invoice balance — the excess is banked as an unapplied receipt',
      { reference, invoiceId, amountRand, pending, unallocated: amountRand - allocated },
      'accounting',
    );
  }
  return {
    allocated, invoiceBlock, overpaid, clientId: invoice.client_id,
    status: invoice.status, deleted: invoice.deleted_at !== null,
  };
}
