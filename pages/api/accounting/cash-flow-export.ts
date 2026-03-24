import { sql } from '@/lib/neon';
/**
 * Cash Flow Statement Export API
 * GET — export cash flow statement as CSV
 *
 * The cash flow data is computed inline (same logic as reports-cash-flow.ts)
 * rather than extracted to a shared service, to keep parity with the source report.
 *
 * Query params:
 *   period_start   YYYY-MM-DD  required
 *   period_end     YYYY-MM-DD  required
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';


/** Escape a value for CSV — wraps in double-quotes and escapes internal quotes. */
function csvVal(value: string | number): string {
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    // Detect whether account_subtype column exists
    let hasSubtype = false;
    try {
      await sql`SELECT account_subtype FROM gl_accounts LIMIT 1`;
      hasSubtype = true;
    } catch {
      // Column absent — fall back to name-matching
    }

    // Opening cash balance (bank accounts before period start)
    let openingBalance = 0;
    try {
      if (hasSubtype) {
        const [row] = await sql`
          SELECT COALESCE(SUM(
            CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
          ), 0)::numeric AS balance
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype = 'bank'
            AND je.status = 'posted'
            AND je.entry_date < ${periodStart}
        `;
        openingBalance = Number(row?.balance || 0);
      } else {
        const [row] = await sql`
          SELECT COALESCE(SUM(
            CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
          ), 0)::numeric AS balance
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE (ga.account_name ILIKE '%bank%' OR ga.account_code LIKE '11%')
            AND ga.account_type = 'asset'
            AND je.status = 'posted'
            AND je.entry_date < ${periodStart}
        `;
        openingBalance = Number(row?.balance || 0);
      }
    } catch {
      openingBalance = 0;
    }

    // Net income from P&L accounts in period
    const [incomeRow] = await sql`
      SELECT
        COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0)::numeric
        - COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric
        AS net_income
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND ga.account_type IN ('revenue', 'expense')
    `;
    const netIncome = Number(incomeRow?.net_income || 0);

    // Change in Accounts Receivable
    let arChange = 0;
    try {
      if (hasSubtype) {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype = 'receivable'
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        arChange = Number(row?.change || 0);
      } else {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_name ILIKE '%receivable%'
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        arChange = Number(row?.change || 0);
      }
    } catch { arChange = 0; }

    // Change in Accounts Payable
    let apChange = 0;
    try {
      if (hasSubtype) {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype = 'payable'
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        apChange = Number(row?.change || 0);
      } else {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_name ILIKE '%payable%'
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        apChange = Number(row?.change || 0);
      }
    } catch { apChange = 0; }

    // Investing: fixed asset changes
    let investingChange = 0;
    try {
      if (hasSubtype) {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_subtype IN ('fixed_asset', 'other_asset')
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        investingChange = Number(row?.change || 0);
      } else {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'asset'
            AND ga.account_name NOT ILIKE '%bank%'
            AND ga.account_name NOT ILIKE '%receivable%'
            AND ga.account_name NOT ILIKE '%cash%'
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        investingChange = Number(row?.change || 0);
      }
    } catch { investingChange = 0; }

    // Financing: equity changes (excluding retained earnings)
    let financingChange = 0;
    try {
      if (hasSubtype) {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'equity'
            AND (ga.account_subtype IS NULL OR ga.account_subtype != 'retained_earnings')
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        financingChange = Number(row?.change || 0);
      } else {
        const [row] = await sql`
          SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id = jl.gl_account_id
          WHERE ga.account_type = 'equity'
            AND ga.account_name NOT ILIKE '%retained%'
            AND je.status = 'posted'
            AND je.entry_date >= ${periodStart}
            AND je.entry_date <= ${periodEnd}
        `;
        financingChange = Number(row?.change || 0);
      }
    } catch { financingChange = 0; }

    const operatingTotal = netIncome + arChange + apChange;
    const investingTotal = investingChange;
    const financingTotal = financingChange;
    const netCashFlow = operatingTotal + investingTotal + financingTotal;
    const closingBalance = openingBalance + netCashFlow;

    const csvLines: string[] = [
      'Section,Description,Amount',
      // Operating Activities
      `${csvVal('Operating Activities')},${csvVal('Net Income')},${netIncome.toFixed(2)}`,
      `${csvVal('Operating Activities')},${csvVal('Change in Accounts Receivable')},${arChange.toFixed(2)}`,
      `${csvVal('Operating Activities')},${csvVal('Change in Accounts Payable')},${apChange.toFixed(2)}`,
      `${csvVal('Operating Activities')},${csvVal('Total Operating Activities')},${operatingTotal.toFixed(2)}`,
      // Investing Activities
      `${csvVal('Investing Activities')},${csvVal('Fixed Asset Changes')},${investingChange.toFixed(2)}`,
      `${csvVal('Investing Activities')},${csvVal('Total Investing Activities')},${investingTotal.toFixed(2)}`,
      // Financing Activities
      `${csvVal('Financing Activities')},${csvVal('Equity Changes')},${financingChange.toFixed(2)}`,
      `${csvVal('Financing Activities')},${csvVal('Total Financing Activities')},${financingTotal.toFixed(2)}`,
      // Summary
      `${csvVal('Summary')},${csvVal('Net Cash Flow')},${netCashFlow.toFixed(2)}`,
      `${csvVal('Summary')},${csvVal('Opening Balance')},${openingBalance.toFixed(2)}`,
      `${csvVal('Summary')},${csvVal('Closing Balance')},${closingBalance.toFixed(2)}`,
    ];

    const csv = csvLines.join('\n');
    const filename = `cash-flow-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export cash flow statement', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export cash flow statement');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
