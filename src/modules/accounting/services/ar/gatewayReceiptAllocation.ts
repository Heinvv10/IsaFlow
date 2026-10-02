/**
 * How much of a gateway receipt its invoice takes (R-181 review round 1).
 *
 * The decision is made under a row lock on the invoice. Read unlocked, two
 * settlements for one invoice (two Paystack references, or a manual receipt at
 * the same moment) both saw the full balance and both allocated it, and
 * `confirmCustomerPayment` adds to `amount_paid` with no cap; an invoice
 * cancelled mid-flight still took its allocation.
 *
 * LOCK ORDER (`customerInvoiceLock.ts`, `bank/.claude.md`): the caller inserts
 * the receipt's own `customer_payments` row first, then this takes the invoice:
 * payment-then-invoice, the canonical sequence. A 55P03 after 5s becomes
 * `CustomerInvoiceLockTimeoutError` and rolls the settlement back, so nothing is
 * lost: the webhook answers 500 and Paystack redelivers; verify logs it and
 * leaves the request pending for the webhook.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withCustomerInvoiceLock } from './customerInvoiceLock';
import { invoiceReview } from './gatewaySettlementReview';

/** A cent. Matches confirmCustomerPayment's own settle tolerance. */
const EPS = 0.01;

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

  // An invoice outside the ledger takes none of it: the whole receipt stays on the
  // customer unapplied, for a person to place.
  const invoiceBlock = invoiceReview(invoice.status, invoice.deleted_at) ?? hold;
  // The gateway can settle more than the invoice still owes — an EFT part-payment
  // landing between the payment link and the card charge is enough. The excess is
  // real cash in the bank, so the receipt is banked in full and only the part the
  // invoice can absorb is allocated; the remainder stays on the customer as an
  // unapplied receipt. Truncating the receipt to fit would drop that cash.
  const outstanding = Number(invoice.locked_total) - Number(invoice.amount_paid ?? 0) - pending;
  const allocated = invoiceBlock ? 0 : Math.max(0, Math.min(amountRand, outstanding));
  const overpaid = !invoiceBlock && amountRand - allocated > EPS;
  if (overpaid) {
    log.warn(
      'Gateway receipt exceeds the invoice balance — the excess is banked as an unapplied receipt',
      { reference, invoiceId, amountRand, outstanding, pending, unallocated: amountRand - allocated },
      'accounting',
    );
  }
  return {
    allocated, invoiceBlock, overpaid, clientId: invoice.client_id,
    status: invoice.status, deleted: invoice.deleted_at !== null,
  };
}
