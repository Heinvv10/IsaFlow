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
 *
 * The pairing walks the CHAIN, never the row order. A document may be deleted
 * and restored more than once — `prepareInvoiceDelete` says so in as many words
 * — and each round trip extends one chain: O <- R <- R2 <- R3 <- R4. Every
 * delete reversal lands on TODAY, so `ORDER BY je.entry_date, je.id` leaves a
 * random UUID deciding which candidate a greedy pass sees first, and when R3
 * came first it paired with R2 and left R and R4 standing — 8 of 8 documents
 * itemised on a fixture where 4 had mis-paired, for the full gross value each.
 * So the walk starts only at a HEAD — a candidate whose target is not itself a
 * candidate — and pairs consecutive links from there, which is a property of
 * the chain and not of the order the rows arrived in. A link whose pair does
 * not net to zero is left standing and the walk continues past it, so a partial
 * correction mid-chain still surfaces and never drags its neighbours out.
 */

import type { DbRow } from '@/lib/neon';

/** Drop candidates that cancel one another exactly through `reversal_of_id`. */
export function dropCancelledReversalPairs(rows: readonly DbRow[]): DbRow[] {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  /** target id -> the candidate that reverses it. At most one: the UNIQUE on
   *  (company_id, reversal_of_id) forbids two reversals of one entry. */
  const reverserOf = new Map<string, DbRow>();
  for (const row of rows) {
    if (row.reversal_of_id != null) reverserOf.set(String(row.reversal_of_id), row);
  }

  const cancelled = new Set<string>();
  for (const head of rows) {
    // Heads only. A candidate whose target is also a candidate is reached by
    // the walk that owns it, never by a walk of its own.
    if (head.reversal_of_id != null && byId.has(String(head.reversal_of_id))) continue;

    const seen = new Set<string>();
    let current: DbRow | undefined = head;
    while (current) {
      const currentId = String(current.id);
      if (seen.has(currentId)) break;
      seen.add(currentId);
      const next: DbRow | undefined = reverserOf.get(currentId);
      if (!next) break;
      const nextId = String(next.id);
      if (seen.has(nextId)) break;
      const net = Number(current.control_credit ?? 0) + Number(next.control_credit ?? 0);
      if (Math.round(net * 100) !== 0) {
        // Not a cancelling pair: `current` stands, and `next` starts the next.
        current = next;
        continue;
      }
      cancelled.add(currentId);
      cancelled.add(nextId);
      seen.add(nextId);
      current = reverserOf.get(nextId);
    }
  }

  return cancelled.size === 0 ? [...rows] : rows.filter((r) => !cancelled.has(String(r.id)));
}
