/**
 * The ledger-vs-statement gap, decomposed into its two directions.
 *
 * Split from `bankCoverageQueries` to stay inside the 300-line cap; it is one
 * query and it is the one the whole report exists for.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';


export interface CoverageDirectionRow {
  bankAccountId: string;
  /** Posted GL movement on the account that NO bank transaction points at. */
  glOnlyMovement: number;
  /** SUM(amount) of imported transactions carrying no journal line. */
  statementOnlyMovement: number;
}

/**
 * The gap between the ledger and the statement, decomposed into its two
 * directions.
 *
 * This is the whole point of the report and it is an exact identity, not an
 * estimate. A matched transaction's `amount` equals its journal leg to the cent
 * on all 9,097 matched rows in production — verified, no exceptions — so the
 * matched halves cancel and:
 *
 *   glBalance - statementBalance == glOnlyMovement - statementOnlyMovement
 *
 * That was checked against both audited companies and the residual was 0.00 on
 * each. A non-zero residual therefore means the sign convention or the matching
 * has broken, and the report surfaces it rather than presenting a gap it cannot
 * explain.
 *
 * BOTH directions matter and neither is visible from the other side alone.
 * Velocity has twelve 1610xxx paycard accounts carrying GL balances with ZERO
 * bank transactions, mirrored by 1544xxx accounts carrying transactions with no
 * GL. A report that only listed "statement rows missing from the GL" would find
 * half of it and read as complete.
 */
export async function fetchCoverageDirections(
  companyId: string,
  asAt: string,
  bankAccountId?: string,
): Promise<CoverageDirectionRow[]> {
  const rows = (await sql`
    SELECT ga.id,
           COALESCE(SUM(CASE
             WHEN je.id IS NOT NULL
              AND NOT EXISTS (
                    SELECT 1 FROM bank_transactions bt
                     WHERE bt.matched_journal_line_id = jl.id
                       AND bt.company_id = ${companyId}::UUID)
             THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric AS gl_only,
           COALESCE((
             SELECT SUM(bt2.amount) FROM bank_transactions bt2
              WHERE bt2.bank_account_id = ga.id
                AND bt2.company_id = ${companyId}::UUID
                AND bt2.transaction_date <= ${asAt}::DATE
                AND bt2.matched_journal_line_id IS NULL), 0)::numeric AS statement_only
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl
             ON jl.gl_account_id = ga.id
            AND jl.company_id    = ${companyId}::UUID
      LEFT JOIN gl_journal_entries je
             ON je.id         = jl.journal_entry_id
            AND je.company_id = ${companyId}::UUID
            AND je.status     = 'posted'
            AND je.entry_date <= ${asAt}::DATE
     WHERE ga.company_id      = ${companyId}::UUID
       AND ga.account_subtype = ANY(${BANK_SUBTYPES as string[]})
       AND (${bankAccountId ?? null}::UUID IS NULL OR ga.id = ${bankAccountId ?? null}::UUID)
     GROUP BY ga.id
  `) as DbRow[];

  return rows.map((r) => ({
    bankAccountId: String(r.id),
    glOnlyMovement: Number(r.gl_only ?? 0),
    statementOnlyMovement: Number(r.statement_only ?? 0),
  }));
}
