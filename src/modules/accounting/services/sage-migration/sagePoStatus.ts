/**
 * Sage PO status -> the status word bulk_create_purchase_orders takes (design note, Phase B): Pending and Overdue are open
 * (approved), Invoiced is closed (the imported POs have no linked IsaFlow bill), Cancelled is cancelled. Case-insensitive.
 * Any other status is refused (`unknown_status`): it is not guessed.
 *
 * ONE decision lives in `OPEN_SAGE_PO_IMPORTED_AS`: how a Sage PO that is still open (Pending, Overdue) is imported. Today it goes
 * in as `open` (approved: it commits budget and passes the approval budget check). `draft` would put it in unapproved, to be
 * approved in IsaFlow. Changing the constant changes both statuses and nothing else.
 */
export type ImportStatusWord = 'open' | 'draft' | 'billed' | 'cancelled';

export const OPEN_SAGE_PO_IMPORTED_AS: 'open' | 'draft' = 'open';

/** The status table for a choice of how open Sage POs go in (exported so a test can try the other choice). */
export function statusTableFor(openAs: 'open' | 'draft'): Readonly<Record<string, ImportStatusWord>> {
  return { pending: openAs, overdue: openAs, invoiced: 'billed', cancelled: 'cancelled' };
}

const TABLE = statusTableFor(OPEN_SAGE_PO_IMPORTED_AS);

export function importStatusFor(sageStatus: string): ImportStatusWord | null {
  const key = sageStatus.trim().toLowerCase();
  return Object.hasOwn(TABLE, key) ? TABLE[key]! : null;
}
