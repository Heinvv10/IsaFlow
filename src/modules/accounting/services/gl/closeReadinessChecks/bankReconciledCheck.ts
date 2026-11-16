/**
 * Bank Reconciliation close-readiness check.
 *
 * Counts the period's unreconciled bank lines by the shared definition (bank/unreconciledLineSql): a posted line
 * dated in the period that is neither reconciled (a completed reconciliation, or the Sage import) nor excluded.
 * Allocating or reviewing a line does not reconcile it (Review is a stamp since migration 980), so allocated,
 * matched and provisional lines all count until a reconciliation that covers them completes.
 *
 * Until 2026-11-15 this counted only `imported` and `matched`, so a period whose lines were all allocated but never
 * reconciled passed. Hein, 2026-11-15: such a period must not close.
 *
 * Where a `fail` blocks: every close, lock and year-end path refuses on it through the shared gate
 * (periodCloseGate): the app's Close, Bulk Close, Close Year, Lock and Bulk Lock (fiscal-periods-action), MCP
 * `close_fiscal_period` (dry run included), and the year-end close (yearEndCloseService.closeFiscalYear: MCP
 * `year_end_close` and /api/accounting/year-end, preview included), which judges every period it locks (Hein,
 * 2026-11-15). `period_close_checklist`, the close-readiness route behind the Fiscal Periods tab's checklist
 * (CloseReadinessChecklist) and the close run (closeRunService) only report it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';
import { UNRECONCILED_LINE_SQL } from '../../bank/unreconciledLineSql';

type Row = DbRow;

/** Where every bank_reconciled row links (pass, fail, busy, could not compute): the reconciliation screen. */
export const BANK_RECONCILED_FIX_HREF = '/accounting/bank-reconciliation';

export async function bankReconciledCheck(
  companyId: string,
  period: { startDate: string; endDate: string },
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT COUNT(*) AS unreconciled_count
    FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.transaction_date BETWEEN ${period.startDate}::date AND ${period.endDate}::date
      AND ${sql.unsafe(UNRECONCILED_LINE_SQL)}
  `) as Row[];

  const count = Number(rows[0]?.unreconciled_count ?? 0);

  if (count === 0) {
    return {
      key: 'bank_reconciled',
      label: 'Bank reconciled',
      status: 'pass',
      reason: 'Every bank transaction in this period is reconciled or excluded.',
      fixHref: BANK_RECONCILED_FIX_HREF,
    };
  }

  const one = count === 1;
  return {
    key: 'bank_reconciled',
    label: 'Bank reconciled',
    status: 'fail',
    reason: `${count} unreconciled bank transaction${one ? ' remains' : 's remain'} in this period. Allocating or `
      + `reviewing a line does not reconcile it: complete a bank reconciliation that covers ${one ? 'it' : 'them'}, `
      + `or exclude ${one ? 'it' : 'them'}.`,
    fixHref: BANK_RECONCILED_FIX_HREF,
  };
}
