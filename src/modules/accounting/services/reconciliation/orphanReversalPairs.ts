/**
 * K-053: the control movements a delete/undo round trip leaves behind, which
 * are not reconciling items.
 *
 * `unappliedCashService` mechanism 2 reports every posted control movement no
 * sub-ledger document references. A soft-delete posts R (reversing the
 * document's journal O) and records it in `soft_delete_journal_reversals`, and
 * the query excludes it by that row. The UNDO — `reinstateInvoiceJournal` —
 * DELETEs that row and posts R2 reversing R, so after one round trip the
 * ledger holds O, R and R2, the invoice still points at O, and NEITHER R nor
 * R2 is claimed by a document or by an sdjr row. Both therefore passed every
 * `NOT EXISTS` and landed in `withoutPaymentRecord` for the document's full
 * gross value each. The `total` nets to zero so the headline figure looked
 * right; the ITEMISATION — the part an operator works through line by line —
 * gained two entries for a document that is restored and perfectly reconciled.
 *
 * The rule is stated by OUTCOME, not by provenance, so it needs no new
 * bookkeeping and repairs the round trips that already happened before this
 * change (their sdjr rows are gone and cannot be recovered): a candidate that
 * is reversed by ANOTHER candidate, for exactly the opposite control movement,
 * contributes nothing to the reconciliation and both are dropped.
 *
 * It fails safe in the other direction, which is the direction that matters:
 *
 *  - A manual reversal M of a live document's journal (`O <- M`) has no partner
 *    among the candidates — O is claimed by the document — so M is still
 *    reported. That is right: the control has moved and the sub-ledger has not.
 *  - An as-at date BETWEEN R and R2 sees only R, so R is still reported. That
 *    is right too: at that date the control account had netted the document
 *    away while the restored invoice's `deleted_at IS NULL` keeps it on the
 *    sub-ledger side.
 *  - A pair whose amounts do not cancel to the cent is left alone, so a
 *    partial correction is never swallowed.
 *
 * Rounding to cents before comparing, because the two legs are numeric sums
 * read back through `Number` and an exact `=== 0` on floats is not the test
 * this wants to make.
 */

import type { DbRow } from '@/lib/neon';

/** Drop candidates that cancel one another exactly through `reversal_of_id`. */
export function dropCancelledReversalPairs(rows: readonly DbRow[]): DbRow[] {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const cancelled = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    if (row.reversal_of_id == null || cancelled.has(id)) continue;
    const targetId = String(row.reversal_of_id);
    const target = byId.get(targetId);
    if (!target || cancelled.has(targetId)) continue;
    const net = Number(row.control_credit ?? 0) + Number(target.control_credit ?? 0);
    if (Math.round(net * 100) !== 0) continue;
    cancelled.add(id);
    cancelled.add(targetId);
  }
  return cancelled.size === 0 ? [...rows] : rows.filter((r) => !cancelled.has(String(r.id)));
}
