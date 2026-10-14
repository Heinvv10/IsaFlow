/**
 * Mechanism 1 of the unapplied-cash reader: a PAYMENT DOCUMENT exists and its
 * cash is not applied to anything. Split from `unappliedCashService` for the
 * 300-line rule; mechanism 2 (control movement no document claims at all) stays
 * there with the orchestration.
 *
 * WHICH PAYMENTS ARE UNAPPLIED IS NOT DECIDED HERE. It is
 * `shared/unappliedPaymentBasis.ts`, the same function `list_unapplied_receipts`
 * and `list_unapplied_payments` read: one status filter, one threshold, one
 * basis. The reconciler used to decide it again and differently — posted
 * control movement rather than document total, `!== 0` rather than a cent, and
 * `<> 'cancelled'` on both sides rather than AP's lifecycle filter — so two
 * tools answered one question with two numbers on the same books.
 *
 * WHAT IS MEASURED HERE, AND WHY IT MUST BE. A reconciling item's amount is the
 * part of `subledgerTotal − controlAccountBalance` that it explains, so it has
 * to be the payment's movement ON THE CONTROL ACCOUNT, not its document total.
 * A receipt that credited some other account moves neither side and explains
 * nothing: on isaflow_dev, Britech has 130 receipts worth R7,505,599 by the
 * document basis against an AR control balance of −R329,700, and an item of
 * R7.5m there produces an equal and opposite R7.5m of `unexplained_difference`
 * — the same shape of artefact as the control-account posting probe that this
 * workstream removed.
 *
 * So the SET and the document figure come from the shared basis, the AMOUNT is
 * the control-side figure, both are carried on the item, and the gap between
 * them is reported as `offControl` rather than absorbed. Where the cash is
 * where it should be the two are equal and the tools agree exactly.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getUnappliedPaymentBasis } from '../shared/unappliedPaymentBasis';
import { round2 } from './reconciliationMath';
import type { UnappliedCashItem, OffControlCash } from './unappliedCashTypes';

export interface PaymentCash {
  withPaymentRecord: UnappliedCashItem[];
  appliedRecords: UnappliedCashItem[];
  offControl: OffControlCash[];
  /** MAX(created_at) over the payments and their allocations. Never now(). */
  postedThrough: string | null;
}

function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * @param controlAccountIds the RESOLVED control accounts. Never empty here —
 *   the caller short-circuits, because with no control account there is nothing
 *   for cash to be unapplied against.
 * @param asAtDate 'YYYY-MM-DD'. String throughout — no Date arithmetic.
 */
export async function getUnappliedPaymentCash(
  companyId: string,
  side: 'ar' | 'ap',
  asAtDate: string,
  controlAccountIds: readonly string[],
): Promise<PaymentCash> {
  const ids = [...controlAccountIds];
  const isAr = side === 'ar';

  const basis = await getUnappliedPaymentBasis(companyId, side, asAtDate);
  const paymentIds = basis.rows.map((r) => r.paymentId);

  // Each payment's movement on the RESOLVED control accounts — the part of the
  // difference it can explain. A payment whose journal went somewhere else
  // returns no row here.
  //
  // A journal that carries SEVERAL live documents of this side (a split bank
  // allocation: one payment per supplier line, bank/bankSplitContacts) moved the
  // control for all of them at once. Each document is given its SHARE of the
  // journal's posted control movement, by its total: still the ledger's figure
  // (a posting that differs from the documents shows as offControl), never a
  // sibling's movement counted twice. One document: its share is the whole.
  //
  // AR and AP are SEPARATE queries rather than one branching on a boolean
  // parameter: that form type-checked, ran without error and returned nothing
  // on data where a manual join found the rows.
  const movementRows = paymentIds.length === 0
    ? []
    : ((await (isAr
      ? sql`
        SELECT p.id,
               COALESCE(SUM(jl.credit - jl.debit), 0) * COALESCE(p.total_amount / NULLIF((
                 SELECT SUM(s.total_amount) FROM customer_payments s
                 WHERE s.company_id = p.company_id AND s.gl_journal_entry_id = p.gl_journal_entry_id
                   AND COALESCE(s.status, '') <> 'cancelled'), 0), 1) AS control_movement
        FROM customer_payments p
        JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
                                  AND je.entry_date <= ${asAtDate}::DATE
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                AND jl.company_id = ${companyId}::UUID
                                AND jl.gl_account_id = ANY(${ids}::uuid[])
        WHERE p.company_id = ${companyId}::UUID
          AND p.id = ANY(${paymentIds}::uuid[])
        GROUP BY p.id, p.company_id, p.gl_journal_entry_id, p.total_amount
      `
      : sql`
        SELECT p.id,
               COALESCE(SUM(jl.debit - jl.credit), 0) * COALESCE(p.total_amount / NULLIF((
                 SELECT SUM(s.total_amount) FROM supplier_payments s
                 WHERE s.company_id = p.company_id AND s.gl_journal_entry_id = p.gl_journal_entry_id
                   AND COALESCE(s.status, '') <> 'cancelled'), 0), 1) AS control_movement
        FROM supplier_payments p
        JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
                                  AND je.entry_date <= ${asAtDate}::DATE
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                AND jl.company_id = ${companyId}::UUID
                                AND jl.gl_account_id = ANY(${ids}::uuid[])
        WHERE p.company_id = ${companyId}::UUID
          AND p.id = ANY(${paymentIds}::uuid[])
        GROUP BY p.id, p.company_id, p.gl_journal_entry_id, p.total_amount
      `)) as DbRow[]);
  const movementById = new Map(
    movementRows.map((r) => [String(r.id), Number(r.control_movement ?? 0)]),
  );

  const withPaymentRecord: UnappliedCashItem[] = [];
  const appliedRecords: UnappliedCashItem[] = [];
  const offControl: OffControlCash[] = [];

  for (const r of basis.rows) {
    const movement = movementById.get(r.paymentId) ?? 0;
    // Allocations capped into [0, movement]: applying more than the cash that
    // arrived must not make the item negative and net off a real remainder on
    // another payment in the same total.
    //
    // THE FLOOR AT ZERO IS NOT DEFENSIVE. A supplier REFUND is a
    // `supplier_payments` row whose control leg is CREDITED (DR Bank / CR
    // Accounts Payable), so its movement is NEGATIVE. A bare `min` picked that
    // negative movement as the allocated figure even with nothing allocated,
    // the item came out at exactly zero, the payment dropped out of the
    // itemisation, its value became an unnamed residual, and the warning row
    // below claimed the cash had never reached a control account -- it had,
    // in the other direction. With the floor the item is the movement itself,
    // signed the way it moved the account.
    const allocatedOnControl = Math.min(r.allocatedAmount, Math.max(0, movement));
    const amount = round2(movement - allocatedOnControl);
    const item: UnappliedCashItem = {
      id: r.paymentId,
      documentNumber: r.paymentNumber === '' ? null : r.paymentNumber,
      entityName: r.entityName,
      documentDate: r.paymentDate,
      amount,
      documentUnapplied: r.unappliedAmount,
      gross: r.totalAmount,
    };
    // A zero-amount row reads to an agent as a finding and is not one.
    if (amount !== 0) withPaymentRecord.push(item);
    if (allocatedOnControl !== 0) {
      appliedRecords.push({ ...item, amount: round2(allocatedOnControl) });
    }
    // The two figures the two tools report, subtracted. For a payment whose
    // cash is where it should be they are equal and this is zero; where they
    // differ -- partly posted, reversed, or posted in the refund direction --
    // the gap is named rather than reconciled away. See reconcilingWarnings.
    const off = round2(r.unappliedAmount - amount);
    if (off !== 0) {
      offControl.push({
        paymentId: r.paymentId,
        documentNumber: r.paymentNumber === '' ? null : r.paymentNumber,
        amount: off,
      });
    }
  }

  return {
    withPaymentRecord,
    appliedRecords,
    offControl,
    postedThrough: laterIso(basis.totals.postedThrough, basis.allocationsPostedThrough),
  };
}
