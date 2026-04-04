/**
 * Year-End Service
 * Fiscal year closing: validate open periods, calculate net income,
 * create closing journal entry, lock periods.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FiscalYearSummary {
  year_label: string;
  start_date: Date | string;
  end_date: Date | string;
  periods_open: number;
  periods_closed: number;
  status: 'open' | 'all_closed';
  total_revenue: number;
  total_expenses: number;
  net_income: number;
}

export interface CloseYearResult {
  closingEntry: Record<string, unknown>;
  netIncome: number;
  message: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listFiscalYears(companyId: string): Promise<FiscalYearSummary[]> {
  const years = await sql`
    SELECT
      fiscal_year                                                          AS year_label,
      MIN(start_date)                                                      AS start_date,
      MAX(end_date)                                                        AS end_date,
      COUNT(*) FILTER (WHERE status = 'open')::int                        AS periods_open,
      COUNT(*) FILTER (WHERE status IN ('closed', 'locked'))::int         AS periods_closed,
      CASE
        WHEN COUNT(*) FILTER (WHERE status = 'open') = 0
         AND COUNT(*) FILTER (WHERE status IN ('closed', 'locked')) > 0
        THEN 'all_closed'
        ELSE 'open'
      END                                                                  AS status
    FROM fiscal_periods
    WHERE company_id = ${companyId}
    GROUP BY fiscal_year
    ORDER BY MIN(start_date) DESC
  `;

  return Promise.all(
    years.map(async (fy) => {
      const [rev] = await sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'revenue'
          AND je.company_id = ${companyId}
          AND je.status     = 'posted'
          AND je.entry_date >= ${fy.start_date}
          AND je.entry_date <= ${fy.end_date}
      `;
      const [exp] = await sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'expense'
          AND je.company_id = ${companyId}
          AND je.status     = 'posted'
          AND je.entry_date >= ${fy.start_date}
          AND je.entry_date <= ${fy.end_date}
      `;

      return {
        ...fy,
        periods_open: Number(fy.periods_open),
        periods_closed: Number(fy.periods_closed),
        total_revenue: Number(rev?.total ?? 0),
        total_expenses: Number(exp?.total ?? 0),
        net_income: Number(rev?.total ?? 0) - Number(exp?.total ?? 0),
      } as FiscalYearSummary;
    })
  );
}

// ─── Close year ───────────────────────────────────────────────────────────────

export type CloseYearError =
  | { error: 'open_periods'; count: number }
  | { error: 'year_not_found' }
  | { error: 'no_retained_earnings'; accountCode: string };

export async function closeFiscalYear(
  companyId: string,
  yearLabel: string,
  userId: string
): Promise<CloseYearResult | CloseYearError> {
  // 1. Ensure all periods are closed
  const openRows = await sql`
    SELECT COUNT(*)::int AS cnt FROM fiscal_periods
    WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId} AND status = 'open'
  `;
  const openCount = Number(openRows[0]?.cnt ?? 0);
  if (openCount > 0) return { error: 'open_periods', count: openCount };

  // 2. Get year date range
  const rangeRows = await sql`
    SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date
    FROM fiscal_periods WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
  `;
  const yearRange = rangeRows[0];
  if (!yearRange) return { error: 'year_not_found' };

  // 3. Revenue account balances
  const revenueAccounts = await sql`
    SELECT ga.id, ga.account_code, ga.account_name,
      COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      AND je.status     = 'posted'
      AND je.company_id = ${companyId}
      AND je.entry_date >= ${yearRange.start_date}
      AND je.entry_date <= ${yearRange.end_date}
    WHERE ga.account_type = 'revenue' AND ga.company_id = ${companyId}
    GROUP BY ga.id, ga.account_code, ga.account_name
    HAVING COALESCE(SUM(jl.credit - jl.debit), 0) != 0
  `;

  // 4. Expense account balances
  const expenseAccounts = await sql`
    SELECT ga.id, ga.account_code, ga.account_name,
      COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      AND je.status     = 'posted'
      AND je.company_id = ${companyId}
      AND je.entry_date >= ${yearRange.start_date}
      AND je.entry_date <= ${yearRange.end_date}
    WHERE ga.account_type = 'expense' AND ga.company_id = ${companyId}
    GROUP BY ga.id, ga.account_code, ga.account_name
    HAVING COALESCE(SUM(jl.debit - jl.credit), 0) != 0
  `;

  const totalRevenue = revenueAccounts.reduce((s, a) => s + Number(a.balance), 0);
  const totalExpenses = expenseAccounts.reduce((s, a) => s + Number(a.balance), 0);
  const netIncome = totalRevenue - totalExpenses;

  // 5. Locate retained earnings account
  let reAccountCode = '3200';
  try {
    const settingRows = await sql`SELECT value FROM app_settings WHERE key = 'retained_earnings_account'`;
    if (settingRows[0]?.value) reAccountCode = String(settingRows[0].value);
  } catch { /* use default */ }

  const reRows = await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}
      AND (account_code = ${reAccountCode} OR account_name ILIKE '%retained earnings%')
    LIMIT 1
  `;
  if (!reRows[0]) return { error: 'no_retained_earnings', accountCode: reAccountCode };
  const retainedEarningsId = reRows[0].id;

  // 6. Create closing journal entry
  const totalDebit  = totalRevenue  + (netIncome < 0 ? Math.abs(netIncome) : 0);
  const totalCredit = totalExpenses + (netIncome >= 0 ? netIncome : 0);

  const closingRows = await sql`
    INSERT INTO gl_journal_entries (
      id, company_id, entry_number, entry_date, description,
      source, status, total_debit, total_credit, created_by, created_at
    ) VALUES (
      gen_random_uuid(),
      ${companyId},
      ${'YE-' + yearLabel},
      ${yearRange.end_date},
      ${'Year-End Closing: ' + yearLabel},
      'year_end', 'posted',
      ${totalDebit}, ${totalCredit},
      ${userId}, NOW()
    )
    RETURNING *
  `;
  const closingEntry = closingRows[0];
  if (!closingEntry) throw new Error('Failed to create closing journal entry');

  // 7. DR revenue accounts (zero them out)
  for (const rev of revenueAccounts) {
    await sql`
      INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
      VALUES (gen_random_uuid(), ${closingEntry.id}, ${rev.id}, ${Number(rev.balance)}, 0, 'Year-end close', NOW())
    `;
  }

  // 8. CR expense accounts (zero them out)
  for (const exp of expenseAccounts) {
    await sql`
      INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
      VALUES (gen_random_uuid(), ${closingEntry.id}, ${exp.id}, 0, ${Number(exp.balance)}, 'Year-end close', NOW())
    `;
  }

  // 9. Net income → retained earnings
  if (netIncome >= 0) {
    await sql`
      INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
      VALUES (gen_random_uuid(), ${closingEntry.id}, ${retainedEarningsId}, 0, ${netIncome}, 'Net income to retained earnings', NOW())
    `;
  } else {
    await sql`
      INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
      VALUES (gen_random_uuid(), ${closingEntry.id}, ${retainedEarningsId}, ${Math.abs(netIncome)}, 0, 'Net loss to retained earnings', NOW())
    `;
  }

  // 10. Lock all periods
  await sql`
    UPDATE fiscal_periods SET status = 'locked'
    WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
  `;

  log.info('Year-end processed', {
    year: yearLabel,
    entryId: closingEntry.id,
    netIncome,
    module: 'accounting',
  });

  return {
    closingEntry,
    netIncome,
    message: `Year ${yearLabel} closed. Net income R${netIncome.toFixed(2)} transferred to Retained Earnings.`,
  };
}
