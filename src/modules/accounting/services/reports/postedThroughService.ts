/**
 * `posted_through` — the latest ledger write a figure consumed.
 *
 * It is what makes a number re-derivable. A trial balance signed on 3 September
 * and re-run on the 10th will differ if anyone back-dated a journal in between,
 * and nothing else in the API lets a reader tell that from an arithmetic error.
 * Same `as_at` plus same `posted_through` must give the same figures.
 *
 * It is `MAX(created_at)` of the rows consumed — NEVER `now()`, which changes
 * on every call and proves nothing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * A read that consumed no ledger row. The epoch says so without claiming the
 * figure is as fresh as the clock.
 */
export const NO_LEDGER_READ = '1970-01-01T00:00:00.000Z';

/**
 * MAX(created_at) over the POSTED journal entries a report reads: everything
 * dated on or before `asAtDate`, optionally from `fromDate`.
 *
 * @param asAtDate 'YYYY-MM-DD'. String throughout — no Date arithmetic; SAST is
 *   UTC+2 and this repo has a live UTC-rollback defect class.
 */
export async function getLedgerPostedThrough(
  companyId: string,
  asAtDate: string,
  fromDate?: string,
): Promise<string> {
  const from = fromDate ?? null;
  const rows = (await sql`
    SELECT MAX(je.created_at) AS posted_through
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${asAtDate}::DATE
      AND (${from}::TEXT IS NULL OR je.entry_date >= ${from}::DATE)
  `) as DbRow[];
  const raw = rows[0]?.posted_through;
  if (raw == null) return NO_LEDGER_READ;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}
