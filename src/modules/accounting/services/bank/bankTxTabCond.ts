/**
 * Which statement lines a bank-transactions tab shows (Hein, 2026-11-12; migration 980).
 *
 * New       — still waiting for a person: imported, provisional or NULL status (WP1, 2026-11-15: provisional and
 *             NULL-status lines were on no tab), or allocated / matched but not yet reviewed (NEW_TAB_SQL; the bank
 *             card's "Awaiting review" counts the posted lines it matches).
 * Reviewed  — a person reviewed it (reviewed_at), plus every reconciled line. Reconciled lines stay here
 *             after the reconciliation is completed instead of vanishing from every tab; a reconciled line
 *             with no review stamp (Sage import, or reconciled before review was recorded) shows too.
 * Excluded  — status 'excluded'.
 *
 * The UI still sends the tab as `status` (imported = New, matched = Reviewed). Returns a fixed SQL literal:
 * every arm is keyed on a validated value, nothing from the request is interpolated — safe for `sql.unsafe`.
 */

export type ReconFilter = 'all' | 'unreconciled' | 'reconciled';

/** The New tab's lines. With Reviewed and Excluded it splits every status, NULL included. */
export const NEW_TAB_SQL =
  "(bt.status IS NULL OR bt.status IN ('imported','provisional') OR (bt.status IN ('allocated','matched') AND bt.reviewed_at IS NULL))";

const PLAIN_STATUS_COND: Readonly<Record<string, string>> = {
  excluded: "AND bt.status = 'excluded'",
  reconciled: "AND bt.status = 'reconciled'",
  allocated: "AND bt.status = 'allocated'",
  provisional: "AND bt.status = 'provisional'",
};

export function tabStatusCond(status: string, reconFilter?: ReconFilter): string {
  if (status === 'imported') {
    return `AND ${NEW_TAB_SQL}`;
  }
  if (status === 'matched') {
    const recon = reconFilter === 'unreconciled' ? " AND bt.status <> 'reconciled'"
      : reconFilter === 'reconciled' ? " AND bt.status = 'reconciled'" : '';
    return "AND (bt.status = 'reconciled' OR (bt.status IN ('allocated', 'matched') AND bt.reviewed_at IS NOT NULL))"
      + recon;
  }
  return Object.hasOwn(PLAIN_STATUS_COND, status) ? PLAIN_STATUS_COND[status]! : 'AND FALSE';
}

export function parseReconFilter(v: unknown): ReconFilter | undefined {
  return v === 'all' || v === 'unreconciled' || v === 'reconciled' ? v : undefined;
}
