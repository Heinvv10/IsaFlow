/**
 * The aged report's buckets summed across every customer or supplier, as at a
 * date — for the year-end notes that print a receivables or payables figure
 * and an age table beside it.
 *
 * R-059. Those notes (disclosure notes 3 and 4, AFS notes 10 and 16) each ran
 * their own query: TODAY's `amount_paid` (or no settlement at all — the AFS
 * pair summed `total_amount`), `status NOT IN ('paid', …)` so a document
 * settled after the year end vanished from it, and drafts counted. At a year
 * end of 2026-08-31 with R700 raised on 08-21 and paid on 09-03, the ageing
 * said R700 and the note said R200 — the R200 a draft.
 *
 * `getARAging` / `getAPAging` own the point-in-time reconstruction and its
 * documented limitations (`shared/agingRewind.ts`); this sums what they return
 * and does no arithmetic of its own, so the notes cannot drift from the ageing
 * again. Same pattern as `reconciliation/agedReportTotal.ts`.
 *
 * `gross` adds back `disputed`: the AR service keeps open disputes OUT of the
 * buckets, but a disputed invoice is still receivable, and `gross` is what the
 * reports-ar-aging route totals.
 */

import { getARAging } from '../ar/arAgingService';
import { getAPAging } from '../ap/apAgingService';
import type { AgingSide } from '../shared/agingRewind';
import { round2 } from '../reconciliation/reconciliationMath';

export interface AgedBucketTotals {
  /** Not yet due at the date. */
  current: number;
  /** 1-30 days overdue. */
  days30: number;
  /** 31-60 days overdue. */
  days60: number;
  /** 61-90 days overdue. */
  days90: number;
  /** 91+ days overdue. */
  days120Plus: number;
  /** AR only: open disputes, held outside the buckets. Always 0 on AP. */
  disputed: number;
  /** Everything outstanding at the date: the five buckets plus `disputed`. */
  gross: number;
}

/** @param asAtDate 'YYYY-MM-DD', passed through; the aging services own every date decision. */
export async function getAgedBucketTotals(
  companyId: string,
  side: AgingSide,
  asAtDate: string,
): Promise<AgedBucketTotals> {
  const rows = side === 'ar' ? await getARAging(companyId, asAtDate) : await getAPAging(companyId, asAtDate);
  const sum = (pick: (r: (typeof rows)[number]) => number | undefined) =>
    round2(rows.reduce((s, r) => s + Number(pick(r) ?? 0), 0));
  const totals = {
    current: sum(r => r.current),
    days30: sum(r => r.days30),
    days60: sum(r => r.days60),
    days90: sum(r => r.days90),
    days120Plus: sum(r => r.days120Plus),
    disputed: sum(r => r.disputed),
  };
  return { ...totals, gross: sum(r => r.total + (r.disputed ?? 0)) };
}

/**
 * The age table the notes print: the ageing's own five buckets, then Disputed
 * when there is any, then a Total that is `gross` — so the row foots. The old
 * per-note tables began "Current" at 0-29 days OVERDUE, which put every
 * not-yet-due document in no column at all while the Total still counted it.
 */
export function agedBucketTable(
  t: AgedBucketTotals,
  fmt: (n: number) => string,
): { headers: string[]; rows: string[][] } {
  const headers = ['Current', '30 days', '60 days', '90 days', '120+ days'];
  const cells = [t.current, t.days30, t.days60, t.days90, t.days120Plus];
  if (t.disputed !== 0) {
    headers.push('Disputed');
    cells.push(t.disputed);
  }
  headers.push('Total');
  cells.push(t.gross);
  return { headers, rows: [cells.map(fmt)] };
}
