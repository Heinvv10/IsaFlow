/**
 * Bank Reconciliation close-readiness check.
 *
 * Counts bank transactions still in `imported` or `matched` status for the
 * given period.  Lifecycle per bankReconciliationService.ts and
 * src/modules/accounting/services/bank/.claude.md:
 *   imported → matched → allocated → reconciled
 * `reconciled` is the terminal done-state.  `excluded` transactions are
 * intentionally skipped.  Anything still in `imported` or `matched` has not
 * completed the reconciliation workflow and counts as unreconciled.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';

type Row = DbRow;

export async function bankReconciledCheck(
  companyId: string,
  period: { startDate: string; endDate: string },
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT COUNT(*) AS unreconciled_count
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND transaction_date BETWEEN ${period.startDate}::date AND ${period.endDate}::date
      AND status IN ('imported', 'matched')
  `) as Row[];

  const count = Number(rows[0]?.unreconciled_count ?? 0);

  if (count === 0) {
    return {
      key: 'bank_reconciled',
      label: 'Bank reconciled',
      status: 'pass',
      reason: 'All bank transactions in this period are reconciled or excluded.',
      fixHref: '/accounting/bank-transactions',
    };
  }

  return {
    key: 'bank_reconciled',
    label: 'Bank reconciled',
    status: 'fail',
    reason: `${count} unreconciled bank transaction${count === 1 ? '' : 's'} remain in this period.`,
    fixHref: '/accounting/bank-transactions',
  };
}
