/**
 * Gateway invoice receipts (Paystack).
 *
 * A card payment against a customer invoice used to be applied with a bare
 * `UPDATE customer_invoices SET amount_paid` in two places — the webhook's
 * charge.success branch and the portal return page's verify fallback. Neither
 * wrote a `customer_payments` row or a journal, so the invoice read paid while
 * accounts receivable stayed overstated and the bank account was never debited
 * (K-036).
 *
 * This routes both call sites through the canonical AR posting instead:
 * `confirmCustomerPayment`, which posts DR Bank / CR Receivable for the whole
 * receipt and stamps `gl_journal_entry_id`.
 *
 * The caller must already be inside a transaction (see
 * `withPublicRouteTransaction`) so a GL failure cannot leave the invoice marked
 * paid, and every query below carries `company_id` because that path runs with
 * RLS bypassed.
 */

import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { confirmCustomerPayment } from './customerPaymentAllocationService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { postGatewayFee } from './gatewayFeeService';

/** posting_agent stamp: unattended, so never `human:<userId>`. */
export const GATEWAY_RECEIPT_AGENT = 'system:paystack-receipt:v1';

/** A cent. Matches confirmCustomerPayment's own settle tolerance. */
export const EPS = 0.01;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GatewayInvoiceReceipt {
  companyId: string;
  invoiceId: string;
  /** Settled amount in rand (Paystack reports cents). */
  amountRand: number;
  /** Paystack reference — the idempotency key, stored as bank_reference. */
  reference: string;
  /**
   * When the gateway settled it. K-035 makes a delivery reprocess hours or days
   * later, so dating the receipt at processing time would book a 30 September
   * payment into October — the wrong fiscal and VAT period.
   */
  paidAt?: string | null;
  /** Gateway fee in rand, deducted from the deposit. See postGatewayFee. */
  feeRand?: number | null;
}

interface InvoiceRow {
  client_id: string | null;
  created_by: string;
  total_amount: string;
  amount_paid: string | null;
}

/**
 * Record a settled gateway payment against a customer invoice: one confirmed
 * `customer_payments` row for the WHOLE receipt, allocated to the invoice up to
 * what the invoice still owes, and posted to the ledger by the same code path a
 * manual receipt uses.
 *
 * Idempotent on `reference`: a second call for the same Paystack reference
 * (webhook and verify route both firing, or a webhook redelivery) records
 * nothing and returns null.
 */
export async function recordGatewayInvoiceReceipt(
  receipt: GatewayInvoiceReceipt,
): Promise<{ paymentId: string; journalEntryId?: string } | null> {
  const { companyId, invoiceId, amountRand, reference } = receipt;

  const already = await sql<{
    id: string;
    created_by: string;
    bank_account_id: string | null;
    payment_date: string;
  }>`
    SELECT id, created_by::text AS created_by, bank_account_id::text AS bank_account_id,
           payment_date::text AS payment_date
    FROM customer_payments
    WHERE company_id = ${companyId}::UUID
      AND bank_reference = ${reference}
      AND status IS DISTINCT FROM 'cancelled'
    LIMIT 1
  `;
  if (already[0]) {
    // The receipt is already banked — by the webhook, a redelivery, or the
    // portal verify route. The FEE still may not be: verify carries no fee and
    // exists to beat the webhook, so returning here used to lose the fee leg
    // for every customer who reached the return page. Post it against the
    // receipt that already exists, in that receipt's period.
    log.info('Gateway receipt already recorded', { reference, invoiceId }, 'accounting');
    await postGatewayFee(
      receipt,
      already[0].created_by,
      already[0].bank_account_id,
      already[0].payment_date,
    );
    return null;
  }

  const invRows = await sql<InvoiceRow>`
    SELECT COALESCE(client_id, customer_id) AS client_id, created_by,
           total_amount::text AS total_amount, amount_paid::text AS amount_paid
    FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
  const invoice = invRows[0];
  if (!invoice || !invoice.client_id) {
    throw new Error(`Gateway receipt: invoice ${invoiceId} not found for company ${companyId}`);
  }

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

  // The gateway can settle more than the invoice still owes — an EFT part-payment
  // landing between the payment link and the card charge is enough. The excess is
  // real cash in the bank, so the receipt is banked in full and only the part the
  // invoice can absorb is allocated; the remainder stays on the customer as an
  // unapplied receipt. Truncating the receipt to fit would drop that cash.
  const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid ?? 0) - pending;
  const allocated = Math.max(0, Math.min(amountRand, outstanding));
  const unallocated = amountRand - allocated;
  if (unallocated > EPS) {
    log.warn(
      'Gateway receipt exceeds the invoice balance — the excess is banked as an unapplied receipt',
      { reference, invoiceId, amountRand, outstanding, pending, unallocated },
      'accounting',
    );
  }

  const bankAccount = await getSystemAccount('bank', companyId);
  const actorId = await resolveCompanyActor(companyId, String(invoice.created_by));
  const paymentDate = settlementDate(receipt);

  // Written here rather than through createCustomerPayment: that service
  // requires allocations to equal the payment total, an invariant an
  // over-settlement cannot satisfy, and the only way to satisfy it is to drop
  // the excess. Its balance validation is carried by the clamp above.
  const paymentId = randomUUID();
  await sql`
    INSERT INTO customer_payments (
      id, company_id, client_id, payment_date, total_amount, payment_method,
      bank_reference, bank_account_id, description, created_by
    ) VALUES (
      ${paymentId}::UUID, ${companyId}::UUID, ${invoice.client_id}::UUID, ${paymentDate},
      ${amountRand}, 'card', ${reference}, ${String(bankAccount.id)}::UUID,
      ${`Paystack card payment ${reference}`}, ${actorId}::UUID
    )
  `;
  if (allocated > EPS) {
    await sql`
      INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
      VALUES (${paymentId}::UUID, ${invoiceId}::UUID, ${allocated})
    `;
  }

  const confirmed = await confirmCustomerPayment(companyId, paymentId, actorId, {
    postingAgent: GATEWAY_RECEIPT_AGENT,
  });
  await postGatewayFee(receipt, actorId, String(bankAccount.id), paymentDate);

  log.info(
    'Recorded gateway invoice receipt',
    { reference, invoiceId, paymentId, allocated, unallocated,
      journalEntryId: confirmed.glJournalEntryId },
    'accounting',
  );
  return { paymentId, journalEntryId: confirmed.glJournalEntryId };
}

/**
 * The date the gateway settled, or today when it did not say.
 *
 * A malformed `paid_at` would otherwise reach `fmtDate` as an Invalid Date and
 * make the insert raise 22007 on every redelivery — the same permanent-failure
 * shape a bad actor id used to cause.
 */
function settlementDate(receipt: GatewayInvoiceReceipt): string {
  if (receipt.paidAt) {
    const parsed = new Date(receipt.paidAt);
    if (!Number.isNaN(parsed.getTime())) return fmtDate(parsed);
    log.warn(
      'Gateway receipt carried an unparseable paid_at — dating it today',
      { reference: receipt.reference, paidAt: receipt.paidAt },
      'accounting',
    );
  }
  return fmtDate(new Date());
}

/**
 * A user who actually belongs to the paying company, for the NOT NULL
 * `created_by` a gateway callback has no user to fill.
 *
 * NOT `resolveUserUuid`: its fallback is `SELECT id FROM users … LIMIT 1` with
 * no company filter and no ORDER BY, so an invoice authored by an import string
 * would stamp the payment, its confirmation and its journal with whichever
 * person the heap yielded first — from any tenant. Fails closed instead: a
 * receipt attributed to a stranger is worse than a retryable 500, and K-035
 * makes the redelivery reprocess once a member exists.
 */
async function resolveCompanyActor(companyId: string, invoiceAuthor: string): Promise<string> {
  if (UUID_PATTERN.test(invoiceAuthor)) {
    const owned = await sql<{ user_id: string }>`
      SELECT cu.user_id FROM company_users cu
      WHERE cu.company_id = ${companyId}::UUID AND cu.user_id = ${invoiceAuthor}::TEXT
      LIMIT 1
    `;
    if (owned[0]) return invoiceAuthor;
  }
  // Deterministic, not heap order: the default member, then the oldest.
  const member = await sql<{ user_id: string }>`
    SELECT cu.user_id FROM company_users cu
    JOIN users u ON u.id::TEXT = cu.user_id
    WHERE cu.company_id = ${companyId}::UUID
      AND cu.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY cu.is_default DESC NULLS LAST, cu.created_at ASC NULLS LAST, cu.user_id ASC
    LIMIT 1
  `;
  if (member[0]) return String(member[0].user_id);
  throw new Error(
    `Gateway receipt: company ${companyId} has no member to attribute the payment to`,
  );
}
