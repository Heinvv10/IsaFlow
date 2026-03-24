import { sql } from '@/lib/neon';
/**
 * Cash Flow Statement API
 * GET /api/accounting/reports-cash-flow?start_date=&end_date=
 * Sage equivalent: Reports > Cash Flow Statement
 *
 * Derives cash flow from GL journal lines using account subtypes:
 * - Operating: revenue, expense, receivable, payable changes
 * - Investing: asset account changes (non-cash)
 * - Financing: equity and loan changes
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { start_date, end_date } = req.query;

    const startDate = (start_date as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const endDate = (end_date as string) || new Date().toISOString().split('T')[0];

    // Check if account_subtype column exists (may not be populated)
    let hasSubtype = false;
    try {
      await sql`SELECT account_subtype FROM gl_accounts LIMIT 1`;
      hasSubtype = true;
    } catch {
      // Column doesn't exist
    }

    // Get opening cash balance (bank accounts at start_date)
    let openingBalance = 0;
    try {
      if (hasSubtype) {
        const [openingCash] = await sql`
          SELECT COALESCE(SUM(
            CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
          ), 0)::numeric as balance
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype = 'bank'
            AND je.status = 'posted'
            AND je.entry_date < ${startDate}
        `;
        openingBalance = Number(openingCash?.balance || 0);
      } else {
        // Fall back to account_name matching for bank accounts
        const [openingCash] = await sql`
          SELECT COALESCE(SUM(
            CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
          ), 0)::numeric as balance
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE (ga.account_name ILIKE '%bank%' OR ga.account_code LIKE '11%')
            AND ga.account_type = 'asset'
            AND je.status = 'posted'
            AND je.entry_date < ${startDate}
        `;
        openingBalance = Number(openingCash?.balance || 0);
      }
    } catch {
      openingBalance = 0;
    }

    // Operating Activities: Net Income + changes in working capital
    const [netIncome] = await sql`
      SELECT
        COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0)::numeric
        - COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric
        as net_income
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.entry_date >= ${startDate}
        AND je.entry_date <= ${endDate}
        AND ga.account_type IN ('revenue', 'expense')
    `;

    // Changes in AR (receivable) — use subtype or fallback to account name
    let arChangeVal = 0;
    try {
      if (hasSubtype) {
        const [arChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype = 'receivable'
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        arChangeVal = Number(arChange?.change || 0);
      } else {
        const [arChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_name ILIKE '%receivable%'
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        arChangeVal = Number(arChange?.change || 0);
      }
    } catch { arChangeVal = 0; }

    // Changes in AP (payable)
    let apChangeVal = 0;
    try {
      if (hasSubtype) {
        const [apChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype = 'payable'
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        apChangeVal = Number(apChange?.change || 0);
      } else {
        const [apChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_name ILIKE '%payable%'
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        apChangeVal = Number(apChange?.change || 0);
      }
    } catch { apChangeVal = 0; }

    // Investing: fixed asset changes
    let investingChangeVal = 0;
    try {
      if (hasSubtype) {
        const [investingChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype IN ('fixed_asset', 'other_asset')
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        investingChangeVal = Number(investingChange?.change || 0);
      } else {
        const [investingChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'asset'
            AND ga.account_name NOT ILIKE '%bank%'
            AND ga.account_name NOT ILIKE '%receivable%'
            AND ga.account_name NOT ILIKE '%cash%'
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        investingChangeVal = Number(investingChange?.change || 0);
      }
    } catch { investingChangeVal = 0; }

    // Financing: equity + loan changes
    let financingChangeVal = 0;
    try {
      if (hasSubtype) {
        const [financingChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'equity'
            AND (ga.account_subtype IS NULL OR ga.account_subtype != 'retained_earnings')
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        financingChangeVal = Number(financingChange?.change || 0);
      } else {
        const [financingChange] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric as change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'equity'
            AND ga.account_name NOT ILIKE '%retained%'
            AND je.status = 'posted'
            AND je.entry_date >= ${startDate}
            AND je.entry_date <= ${endDate}
        `;
        financingChangeVal = Number(financingChange?.change || 0);
      }
    } catch { financingChangeVal = 0; }

    const operatingTotal = Number(netIncome?.net_income || 0) + arChangeVal + apChangeVal;
    const investingTotal = investingChangeVal;
    const financingTotal = financingChangeVal;
    const netChange = operatingTotal + investingTotal + financingTotal;

    const report = {
      period_start: startDate,
      period_end: endDate,
      opening_cash: openingBalance,
      sections: [
        {
          section: 'Operating Activities',
          items: [
            { label: 'Net Income', amount: Number(netIncome?.net_income || 0) },
            { label: 'Change in Accounts Receivable', amount: arChangeVal },
            { label: 'Change in Accounts Payable', amount: apChangeVal },
          ],
          total: operatingTotal,
        },
        {
          section: 'Investing Activities',
          items: [
            { label: 'Fixed Asset Changes', amount: investingChangeVal },
          ],
          total: investingTotal,
        },
        {
          section: 'Financing Activities',
          items: [
            { label: 'Equity Changes', amount: financingChangeVal },
          ],
          total: financingTotal,
        },
      ],
      net_change: netChange,
      closing_cash: openingBalance + netChange,
    };

    return apiResponse.success(res, { report });
  } catch (err) {
    log.error('Failed to generate cash flow statement', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to generate cash flow statement');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
