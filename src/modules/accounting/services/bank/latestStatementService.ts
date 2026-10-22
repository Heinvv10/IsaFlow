/**
 * Per bank account, the latest statement entered on a reconciliation and the
 * latest COMPLETED reconciliation — one row per account, read in one query.
 *
 * getReconciliations answers a different question (every session, with its
 * matched / unmatched counts, two correlated counts over bank_transactions per
 * session); a caller that needs only the latest dates and balance should not
 * pay for the company's whole reconciliation history.
 *
 * Latest statement: the session with the latest statement_date, any status; on
 * a tie a completed session wins, then the most recently created (status is
 * nullable — a NULL sorts with the not-completed, never first). Its
 * statement_balance is the closing balance typed from the bank statement. On
 * an in-progress session that reconciliation is not yet signed off: the
 * statement is latest but unconfirmed exactly when lastStatementDate is later
 * than lastReconciledDate.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export interface LatestStatement {
  bankAccountId: string;
  /** YYYY-MM-DD. */
  lastStatementDate: string;
  lastStatementBalance: number;
  /** YYYY-MM-DD of the latest completed reconciliation's statement, or null. */
  lastReconciledDate: string | null;
}

export async function getLatestStatements(companyId: string): Promise<Map<string, LatestStatement>> {
  const rows = (await sql`
    SELECT DISTINCT ON (br.bank_account_id)
      br.bank_account_id, br.statement_date, br.statement_balance,
      MAX(br.statement_date) FILTER (WHERE br.status = 'completed')
        OVER (PARTITION BY br.bank_account_id) AS last_reconciled
    FROM bank_reconciliations br
    WHERE br.company_id = ${companyId}::UUID
    ORDER BY br.bank_account_id, br.statement_date DESC, (br.status = 'completed') DESC NULLS LAST, br.created_at DESC, br.id
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.bank_account_id), {
    bankAccountId: String(r.bank_account_id),
    lastStatementDate: fmtDate(r.statement_date),
    lastStatementBalance: Number(r.statement_balance),
    lastReconciledDate: r.last_reconciled == null ? null : fmtDate(r.last_reconciled),
  }]));
}
