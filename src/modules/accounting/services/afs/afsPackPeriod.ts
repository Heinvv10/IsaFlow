// src/modules/accounting/services/afs/afsPackPeriod.ts
// A management pack has no fiscal year: its period is its own month, stored in
// afs_documents.period as 'YYYY-MM'. The pre-export checks read the ledger up to
// the last day of that month.

import { isPackPeriod } from './afsDocumentTitle';

/** Last calendar day of a pack month ('2026-02' -> '2026-02-28'), or null when the period is missing or not YYYY-MM. */
export function packPeriodEnd(period: string | null | undefined): string | null {
  if (!isPackPeriod(period)) return null;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
}
