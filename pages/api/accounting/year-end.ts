import { sql } from '@/lib/neon';
/**
 * Year-End Processing API
 * GET /api/accounting/year-end - List fiscal years with status
 * POST /api/accounting/year-end - Close a fiscal year (create closing journal)
 * Sage equivalent: Accountant's Area > Year-End
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      // Group fiscal periods by year label
      const years = await sql`
        SELECT
          fiscal_year as year_label,
          MIN(start_date) as start_date,
          MAX(end_date) as end_date,
          COUNT(*) FILTER (WHERE status = 'open')::int as periods_open,
          COUNT(*) FILTER (WHERE status IN ('closed', 'locked'))::int as periods_closed,
          CASE
            WHEN COUNT(*) FILTER (WHERE status = 'open') = 0
             AND COUNT(*) FILTER (WHERE status IN ('closed', 'locked')) > 0
            THEN 'all_closed'
            ELSE 'open'
          END as status
        FROM fiscal_periods
        WHERE company_id = ${companyId}
        GROUP BY fiscal_year
        ORDER BY MIN(start_date) DESC
      `;

      // Get revenue/expense totals per year
      const yearsWithTotals = await Promise.all(years.map(async (fy) => {
        const [rev] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'revenue'
            AND je.company_id = ${companyId}
            AND je.status = 'posted'
            AND je.entry_date >= ${fy.start_date}
            AND je.entry_date <= ${fy.end_date}
        `;
        const [exp] = await sql`
          SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric as total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'expense'
            AND je.company_id = ${companyId}
            AND je.status = 'posted'
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
        };
      }));

      return apiResponse.success(res, { years: yearsWithTotals });
    } catch (err) {
      log.error('Failed to fetch fiscal years', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch fiscal years');
    }
  }

  if (req.method === 'POST') {
    const userId = (req as AuthenticatedNextApiRequest).user.id;
    const { yearLabel, action } = req.body;

    if (action !== 'close') {
      return apiResponse.badRequest(res, 'Only "close" action is supported');
    }

    if (!yearLabel) {
      return apiResponse.validationError(res, { yearLabel: 'Fiscal year label required' });
    }

    try {
      // Check all periods are closed
      const openPeriods = await sql`
        SELECT COUNT(*)::int as cnt FROM fiscal_periods
        WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId} AND status = 'open'
      `;

      if (Number(openPeriods[0]?.cnt ?? 0) > 0) {
        return apiResponse.badRequest(res, `${openPeriods[0]?.cnt} periods still open. Close all periods first.`);
      }

      // Get year date range
      const yearRangeRows = await sql`
        SELECT MIN(start_date) as start_date, MAX(end_date) as end_date
        FROM fiscal_periods WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
      `;
      const yearRange = yearRangeRows[0];
      if (!yearRange) throw new Error('Fiscal year not found');

      // Calculate net income (Revenue - Expenses)
      const revenueAccounts = await sql`
        SELECT ga.id, ga.account_code, ga.account_name,
          COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as balance
        FROM gl_accounts ga
        LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
        LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          AND je.status = 'posted'
          AND je.company_id = ${companyId}
          AND je.entry_date >= ${yearRange.start_date}
          AND je.entry_date <= ${yearRange.end_date}
        WHERE ga.account_type = 'revenue' AND ga.company_id = ${companyId}
        GROUP BY ga.id, ga.account_code, ga.account_name
        HAVING COALESCE(SUM(jl.credit - jl.debit), 0) != 0
      `;

      const expenseAccounts = await sql`
        SELECT ga.id, ga.account_code, ga.account_name,
          COALESCE(SUM(jl.debit - jl.credit), 0)::numeric as balance
        FROM gl_accounts ga
        LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
        LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          AND je.status = 'posted'
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

      // Find retained earnings account — configurable via app_settings or default 3200
      let reAccountCode = '3200';
      try {
        const settingRows = await sql`SELECT value FROM app_settings WHERE key = 'retained_earnings_account'`;
        if (settingRows[0]?.value) reAccountCode = String(settingRows[0].value);
      } catch { /* use default */ }

      const reRows = await sql`
        SELECT id FROM gl_accounts
        WHERE company_id = ${companyId} AND (account_code = ${reAccountCode} OR account_name ILIKE '%retained earnings%')
        LIMIT 1
      `;
      const retainedEarnings = reRows[0];

      if (!retainedEarnings) {
        return apiResponse.badRequest(res, `Retained Earnings account not found (${reAccountCode}). Create the account or set 'retained_earnings_account' in app_settings.`);
      }

      // Create closing journal entry
      const totalDebit = totalRevenue + (netIncome < 0 ? Math.abs(netIncome) : 0);
      const totalCredit = totalExpenses + (netIncome >= 0 ? netIncome : 0);

      const closingEntryRows = await sql`
        INSERT INTO gl_journal_entries (
          id, company_id, entry_number, entry_date, description,
          source, status, total_debit, total_credit,
          created_by, created_at
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
      const closingEntry = closingEntryRows[0];
      if (!closingEntry) throw new Error('Failed to create closing entry');

      // DR Revenue accounts (to zero them)
      for (const rev of revenueAccounts) {
        await sql`
          INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
          VALUES (gen_random_uuid(), ${closingEntry.id}, ${rev.id}, ${Number(rev.balance)}, 0, 'Year-end close', NOW())
        `;
      }

      // CR Expense accounts (to zero them)
      for (const exp of expenseAccounts) {
        await sql`
          INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
          VALUES (gen_random_uuid(), ${closingEntry.id}, ${exp.id}, 0, ${Number(exp.balance)}, 'Year-end close', NOW())
        `;
      }

      // Net income → Retained Earnings
      if (netIncome >= 0) {
        await sql`
          INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
          VALUES (gen_random_uuid(), ${closingEntry.id}, ${retainedEarnings.id}, 0, ${netIncome}, 'Net income to retained earnings', NOW())
        `;
      } else {
        await sql`
          INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
          VALUES (gen_random_uuid(), ${closingEntry.id}, ${retainedEarnings.id}, ${Math.abs(netIncome)}, 0, 'Net loss to retained earnings', NOW())
        `;
      }

      // Lock all periods
      await sql`
        UPDATE fiscal_periods SET status = 'locked' WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
      `;

      log.info('Year-end processed', {
        year: yearLabel,
        entryId: closingEntry.id,
        netIncome,
        module: 'accounting',
      });

      return apiResponse.success(res, {
        closingEntry,
        netIncome,
        message: `Year ${yearLabel} closed. Net income R${netIncome.toFixed(2)} transferred to Retained Earnings.`,
      });
    } catch (err) {
      log.error('Failed to process year-end', { error: err, yearLabel, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to process year-end');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withRole('admin')(withErrorHandler(handler)));
