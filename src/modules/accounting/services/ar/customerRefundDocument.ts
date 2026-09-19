/**
 * The customer refund DOCUMENT: cash going back out to a customer, recorded.
 *
 * ── THE MIRROR, AND IT IS EXACT ─────────────────────────────────────────────
 *
 * `allocateTransaction`'s customer arm posts DR Accounts Receivable / CR Bank
 * for a money-OUT line and then stops. Its `customer_payments` insert is gated
 * on `!isSpent`, correctly and for a reason written into that file: a positive
 * receipt row for a refund is cash the company never received, and it would
 * surface in `list_unapplied_receipts` and on the customer statement as real
 * money — the same orphan shape that once put R1.84m of phantom receipts on one
 * statement.
 *
 * But nothing took its place, so the control account moved and the subledger
 * did not: the journal surfaces under `posting_with_no_document`, and the
 * customer's on-account credit stays overstated by the whole refund.
 *
 * Everything else is `ap/supplierRefundDocument` with the tables swapped —
 * `customer_payments`, `customer_payment_allocations`, `bank_reference` instead
 * of `reference`, and `confirmed` instead of `processed`. Read that file's
 * header for why the sign is a constraint rather than a convention, why the
 * ceiling refuses instead of clamping, and why the plan and the write are split.
 * Repeating it here would be two copies to keep true.
 *
 * ── THE ONE ASYMMETRY, AND IT IS REAL ───────────────────────────────────────
 *
 * The status filter. A `customer_payments` row is created already confirmed —
 * the receipt exists because the money arrived — so the basis takes everything
 * but `cancelled`, where AP takes only `processed` and `reconciled`. The credit
 * query below carries the AR filter, because it must answer the same question
 * as `shared/unappliedPaymentBasis` on the same side and not a third one.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { REFUND_PAYMENT_METHOD, SupplierRefundRefusal } from '../ap/supplierRefundDocument';

/**
 * ONE refusal class for both sides. The two refusals are the same fact about
 * the same kind of mistake, a route answers them identically, and a second
 * class would be a second thing to remember to catch.
 */
export { isSupplierRefundRefusal as isRefundRefusal } from '../ap/supplierRefundDocument';

export interface CustomerRefundPlan {
  amount: number;
  onAccountCredit: number;
  customerName: string;
}

export interface CustomerRefundDocument {
  paymentId: string;
  /** NEGATIVE — the value written to `total_amount`. */
  amount: number;
  onAccountCredit: number;
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * What this customer has sitting on account, as at a date. See the AP twin for
 * why the allocation cap is `GREATEST(total, 0)` and not `LEAST(alloc, total)`.
 */
export async function getCustomerOnAccountCredit(
  companyId: string,
  customerId: string,
  asAt: string,
): Promise<{ credit: number; customerName: string }> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
             cp.total_amount
             - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0))
           ), 0) AS credit,
           MAX(c.name) AS customer_name
    FROM customers c
    LEFT JOIN customer_payments cp
      ON cp.client_id = c.id
     AND cp.company_id = c.company_id
     AND cp.status <> 'cancelled'
     AND cp.payment_date <= ${asAt}::DATE
    LEFT JOIN LATERAL (
      SELECT SUM(cpa.amount_allocated) AS allocated
      FROM customer_payment_allocations cpa
      WHERE cpa.payment_id = cp.id
    ) alloc ON TRUE
    WHERE c.company_id = ${companyId}::UUID
      AND c.id = ${customerId}::UUID
  `) as DbRow[];

  return {
    credit: round2(Number(rows[0]?.credit ?? 0)),
    customerName: rows[0]?.customer_name ? String(rows[0].customer_name) : 'this customer',
  };
}

/** The ceiling check, from a read-only query. WRITES NOTHING. */
export async function planCustomerRefund(
  companyId: string,
  customerId: string,
  amount: number,
  paymentDate: string,
): Promise<CustomerRefundPlan> {
  const gross = round2(Math.abs(amount));
  const { credit, customerName } = await getCustomerOnAccountCredit(
    companyId, customerId, paymentDate,
  );

  if (gross > credit) {
    throw new SupplierRefundRefusal(
      `A refund of ${gross.toFixed(2)} exceeds the ${credit.toFixed(2)} `
      + `${customerName} has on account as at ${paymentDate}. `
      + `Recording it would leave the company owing ${customerName}, which is a `
      + 'payable — it cannot be recorded against Accounts Receivable. Raise a '
      + 'credit note, or allocate this payment to the account it belongs to.',
    );
  }

  return { amount: gross, onAccountCredit: credit, customerName };
}

/**
 * Write the refund document. The journal must already be posted.
 *
 * `created_by` / `confirmed_by` go through `resolveUserUuid` for the reason the
 * customer insert in `allocateTransaction` works around by hand: the column is
 * uuid-typed and NOT NULL, and a GoTrue user id is not always uuid-shaped.
 */
export async function recordCustomerRefund(args: {
  companyId: string;
  customerId: string;
  bankTxId: string;
  bankAccountId: string;
  journalEntryId: string;
  amount: number;
  paymentDate: string;
  description: string;
  userId: string;
}): Promise<CustomerRefundDocument> {
  const {
    companyId, customerId, bankTxId, bankAccountId, journalEntryId,
    amount, paymentDate, description, userId,
  } = args;

  // Re-checked here and not only in the planner — see the AP twin's header.
  const plan = await planCustomerRefund(companyId, customerId, amount, paymentDate);
  const createdBy = await resolveUserUuid(userId);
  const total = round2(-plan.amount);

  const rows = (await sql`
    INSERT INTO customer_payments (
      company_id, client_id, payment_date, total_amount, payment_method,
      bank_reference, bank_account_id, description, status,
      gl_journal_entry_id, created_by, confirmed_by, confirmed_at
    ) VALUES (
      ${companyId}::UUID, ${customerId}::UUID, ${paymentDate}::DATE,
      ${total}, ${REFUND_PAYMENT_METHOD},
      ${bankTxId}, ${bankAccountId}::UUID, ${description}, ${'confirmed'},
      ${journalEntryId}::UUID, ${createdBy}::UUID, ${createdBy}::UUID, NOW()
    )
    RETURNING id
  `) as DbRow[];

  const paymentId = String(rows[0]!.id);
  log.info('Customer refund document recorded', {
    bankTxId, customerId, paymentId, amount: total,
    onAccountCreditBefore: plan.onAccountCredit,
  }, 'accounting');

  return { paymentId, amount: total, onAccountCredit: plan.onAccountCredit };
}
