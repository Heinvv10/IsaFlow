/**
 * The supplier refund DOCUMENT: cash coming back from a supplier, recorded.
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 *
 * `allocateTransaction`'s supplier arm posts DR Bank / CR Accounts Payable for
 * a money-IN line and then stops — `recordSupplierBankPayment` is gated on
 * `isSpent`, correctly, because a refund is not a payment and a positive
 * payment document for it would be cash the company never paid. But nothing
 * took its place, so the control account moved and the subledger did not: the
 * journal surfaces under `posting_with_no_document` in `reconcile_subledger`,
 * and the supplier's on-account credit — computed everywhere from payment
 * documents — stays OVERSTATED by the entire refund. The company shows itself
 * holding credit with a supplier that has already handed the money back.
 *
 * ── THE SHAPE: A NEGATIVE ON-ACCOUNT ENTRY ──────────────────────────────────
 *
 * One `supplier_payments` row, `payment_method = 'refund'`, `total_amount`
 * NEGATIVE, status `processed`, carrying the journal the allocation posted and
 * the bank transaction id in `reference`. NO `payment_allocations` rows, ever,
 * and never auto-applied: "applying" a negative remainder to a bill would
 * un-pay it, which is a correction somebody has to make deliberately.
 *
 * Every per-supplier total that sums unapplied remainders now nets, because a
 * refund is simply a remainder of the other sign. That is the whole design —
 * no second mechanism, no parallel table, no reader that has to remember to
 * subtract something.
 *
 * IT IS NOT A CREDIT NOTE. A credit note is the supplier reducing what it
 * billed; a refund is cash physically back in the bank account. Migration 681
 * carries the same note where the constraint lives.
 *
 * IT POSTS NO JOURNAL. `allocateTransaction` posted the only one.
 *
 * ── THE CEILING, AND WHY IT REFUSES RATHER THAN CLAMPS ──────────────────────
 *
 * A refund returns credit the company was holding. It cannot return more than
 * it held: a refund larger than the supplier's on-account credit as at the
 * payment date leaves the supplier owing the company, and money owed BY a
 * supplier is a receivable — it does not belong on the AP control account under
 * any document shape. Clamping to the available credit would mint a document
 * for part of a bank line and silently leave the rest undocumented, which is
 * the defect this whole workstream exists to remove. So it refuses, and the
 * allocation refuses with it.
 *
 * ── PLAN THEN RECORD, AND WHY THE SPLIT IS LOAD-BEARING ─────────────────────
 *
 * `withAuth` COMMITs the request transaction on a 4xx and rolls back only on a
 * 5xx. A business refusal raised AFTER the journal has posted therefore has
 * exactly two outcomes, both bad: answered 400 it commits an orphan journal,
 * answered 500 it tells the user an internal error occurred.
 *
 * So `planSupplierRefund` runs the whole ceiling check BEFORE anything is
 * written, from a read-only query, and `allocateTransaction` calls it before it
 * creates the journal. Its throw is a `BankAllocationRefusal`, which the routes
 * already answer 400, and at that point there is nothing to roll back.
 *
 * `recordSupplierRefund` re-checks anyway. The second check is not
 * belt-and-braces: the bank-rule sweep and the backfill reach the writer
 * without the planner, and a writer whose invariant lives in its caller has no
 * invariant.
 *
 * BOTH THROWS ARE `SupplierRefundRefusal`, and the routes answer it 400. An
 * earlier draft of this header said `BankAllocationRefusal`, which was wrong
 * and load-bearing: `bank-match-confirm` answers 400 only for
 * `isBankAllocationRefusal`, so an over-credit refund from the bank-match
 * screen came back as "An internal error occurred" with no remedy in it. Both
 * REST routes now name this class too.
 *
 * ── THE LOCK, AND WHY THE CEILING IS NOTHING WITHOUT IT ─────────────────────
 *
 * The ceiling is a check-then-act and the check is the whole safety property.
 * Two concurrent money-in lines against one supplier both read the same credit,
 * both pass, and both mint — two −R1,058 refunds against R1,058, reproduced on
 * dev. The sign CHECK is per row and each row is individually legal; the
 * illegal thing is the PAIR, which no constraint can see.
 *
 * So `planSupplierRefund` takes `lockContactForRefund` BEFORE it reads, and
 * holds it for the rest of the request transaction. The supplier row is the
 * only object the two requests share — the row being guarded is the one about
 * to be inserted. See `core/paymentLock`. An APPLICATION of the supplier's posted
 * cash lowers the same credit and takes no supplier lock, so the planner then
 * tries the supplier's credit key (`ap/supplierCreditLock`): held by an
 * application in flight, the refund is refused (retryable) instead of counting
 * cash already being spent. The application checks the same ceiling from its
 * side (`planSupplierPaymentApplication`).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { lockContactForRefund } from '../core/paymentLock';
import { lockSupplierCredit } from './supplierCreditLock';

/** The one `payment_method` value that carries a negative total. */
export const REFUND_PAYMENT_METHOD = 'refund';

/**
 * A refusal about the MONEY, not about the request. Structural `code` check for
 * the same reason as `isBankAllocationRefusal`: instanceof does not survive a
 * module loaded twice under different resolutions.
 */
export class SupplierRefundRefusal extends Error {
  readonly code = 'SUPPLIER_REFUND_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'SupplierRefundRefusal';
  }
}

export function isSupplierRefundRefusal(err: unknown): err is SupplierRefundRefusal {
  return err instanceof Error
    && (err as { code?: unknown }).code === 'SUPPLIER_REFUND_REFUSED';
}

export interface SupplierRefundPlan {
  /** Always positive: the gross refund, whatever sign the caller passed. */
  amount: number;
  /** The supplier's on-account credit as at the payment date, already netted. */
  onAccountCredit: number;
  supplierName: string;
}

export interface SupplierRefundDocument {
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
 * What this supplier has sitting on account, as at a date.
 *
 * The SAME basis as `shared/unappliedPaymentBasis` — document total minus
 * allocations, over `processed` and `reconciled` rows — restricted to one
 * supplier and returned as a single netted figure. It is not a fourth
 * definition of unapplied cash: the predicate is copied clause for clause, and
 * the integration suite proves the two agree on the same tenant.
 *
 * `GREATEST(sp.total_amount, 0)` is the allocation cap and it is the whole
 * reason this cannot reuse the plain `LEAST(allocated, total_amount)` form. On
 * a refund that form caps the allocations at the NEGATIVE total, so the
 * remainder computes to exactly zero and an earlier refund stops reducing the
 * credit — the second refund would then be measured against a ceiling the first
 * one had already consumed.
 *
 * @param asAt 'YYYY-MM-DD'. String throughout: SAST is UTC+2 and this repo has
 *   a live UTC-rollback defect class around Date arithmetic. `null`: every posted
 *   payment, whatever its date (the application ceiling).
 */
export async function getSupplierOnAccountCredit(
  companyId: string,
  supplierId: string,
  asAt: string | null,
): Promise<{ credit: number; supplierName: string }> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
             sp.total_amount
             - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0))
           ), 0) AS credit,
           MAX(s.name) AS supplier_name
    FROM suppliers s
    LEFT JOIN supplier_payments sp
      ON sp.supplier_id = s.id
     AND sp.company_id = s.company_id
     AND sp.status IN ('processed', 'reconciled')
     AND (${asAt}::DATE IS NULL OR sp.payment_date <= ${asAt}::DATE)
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated
      FROM payment_allocations pa
      WHERE pa.payment_id = sp.id
    ) alloc ON TRUE
    WHERE s.company_id = ${companyId}::UUID
      AND s.id = ${supplierId}::UUID
  `) as DbRow[];

  return {
    credit: round2(Number(rows[0]?.credit ?? 0)),
    supplierName: rows[0]?.supplier_name ? String(rows[0].supplier_name) : 'this supplier',
  };
}

/**
 * The ceiling check, from a read-only query. WRITES NOTHING.
 *
 * Call this BEFORE posting the journal — see the header on why a refusal after
 * the first write cannot be answered honestly.
 *
 * @param amount the gross refund. Signed or unsigned; the absolute value is
 *   used, because the bank line's sign already said which direction this is and
 *   a caller passing it again must not flip the meaning.
 */
export async function planSupplierRefund(
  companyId: string,
  supplierId: string,
  amount: number,
  paymentDate: string,
): Promise<SupplierRefundPlan> {
  const gross = round2(Math.abs(amount));
  // BEFORE the read, and held for the rest of the request. A ceiling read
  // without this lock is a number two concurrent refunds both satisfy.
  await lockContactForRefund(companyId, 'supplier', supplierId);
  // Then the credit key, which every application of posted cash holds from its plan to its COMMIT: held by
  // another request, this refuses (retryable) instead of counting cash an application is spending.
  await lockSupplierCredit(companyId, supplierId);
  const { credit, supplierName } = await getSupplierOnAccountCredit(
    companyId, supplierId, paymentDate,
  );

  if (gross > credit) {
    throw new SupplierRefundRefusal(
      `A refund of ${gross.toFixed(2)} exceeds the ${credit.toFixed(2)} `
      + `${supplierName} has on account as at ${paymentDate}. `
      + `Recording it would leave ${supplierName} owing the company, which is a `
      + 'receivable — it cannot be recorded against Accounts Payable. Capture a '
      + 'supplier invoice for what is owed, or allocate this deposit to the '
      + 'account it belongs to.',
    );
  }

  return { amount: gross, onAccountCredit: credit, supplierName };
}

/**
 * Write the refund document. The journal must already be posted.
 *
 * No allocation, no `amount_paid`, no `payment_allocations` row — see the
 * header. `created_by` is resolved the same way `recordSupplierBankPayment`
 * resolves it: the column is uuid-typed and NOT NULL, and a GoTrue user id is
 * not always uuid-shaped.
 */
export async function recordSupplierRefund(args: {
  companyId: string;
  supplierId: string;
  bankTxId: string;
  bankAccountId: string;
  journalEntryId: string;
  /** The gross refund. Signed or unsigned; the absolute value is used. */
  amount: number;
  paymentDate: string;
  description: string;
  userId: string;
}): Promise<SupplierRefundDocument> {
  const {
    companyId, supplierId, bankTxId, bankAccountId, journalEntryId,
    amount, paymentDate, description, userId,
  } = args;

  // Re-checked here and not only in the planner: the bank-rule sweep reaches
  // this writer without one, and an invariant that lives in a caller is not an
  // invariant. See the header for why this throw is deliberately NOT a 4xx.
  const plan = await planSupplierRefund(companyId, supplierId, amount, paymentDate);
  const createdBy = await resolveUserUuid(userId);
  const total = round2(-plan.amount);

  // R-035 PR5: a refund is money IN, never an instruction to pay — the 867 backstop passes it by content.
  const rows = (await sql`
    INSERT INTO supplier_payments (
      company_id, supplier_id, payment_date, total_amount, payment_method,
      bank_account_id, reference, description, status, gl_journal_entry_id,
      created_by, approved_by, approved_at, processed_at
    ) VALUES (
      ${companyId}::UUID, ${supplierId}::UUID, ${paymentDate}::DATE,
      ${total}, ${REFUND_PAYMENT_METHOD},
      ${bankAccountId}::UUID, ${bankTxId}, ${description}, ${'processed'},
      ${journalEntryId}::UUID,
      ${createdBy}::UUID, ${createdBy}::UUID, NOW(), NOW()
    )
    RETURNING id
  `) as DbRow[];

  const paymentId = String(rows[0]!.id);
  log.info('Supplier refund document recorded', {
    bankTxId, supplierId, paymentId, amount: total,
    onAccountCreditBefore: plan.onAccountCredit,
  }, 'accounting');

  return { paymentId, amount: total, onAccountCredit: plan.onAccountCredit };
}
