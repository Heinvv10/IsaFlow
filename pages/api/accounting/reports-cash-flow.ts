import { sql } from '@/lib/neon';
import {
  CASH_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  PAYABLE_SUBTYPES,
  INVESTING_ASSET_SUBTYPES,
} from '@/modules/accounting/services/gl/accountClassification';
import { fmtDate } from '@/lib/fmtDate';
/**
 * Cash Flow Statement API
 * GET /api/accounting/reports-cash-flow?start_date=&end_date=
 * Sage equivalent: Reports > Cash Flow Statement
 *
 * Derives cash flow from GL journal lines using account subtypes:
 * - Operating: revenue, expense, receivable, payable changes
 * - Investing: asset account changes (non-cash)
 * - Financing: equity and loan changes
 *
 * BL-12: account_subtype exists since migration 260+. Schema probe removed.
 * Six separate grouped aggregates collapsed into one conditional-aggregation query.
 * Opening-balance query moved into the parallel Promise.all batch.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';

// account_subtype column has been present since migration 260+.
// No runtime schema probe needed.
const HAS_SUBTYPE = true as const;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req;

  try {
    // Accept both start_date/end_date (legacy) and period_start/period_end (aligned
     // with income-statement/balance-sheet endpoints)
    const { start_date, end_date, period_start, period_end } = req.query;

    const startDate = (period_start as string) || (start_date as string) || fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const endDate = (period_end as string) || (end_date as string) || new Date().toISOString().split('T')[0];

    // Run opening-balance and the collapsed period aggregate in parallel.
    // P-009: no schema probe. P-002: 6 queries → 1 conditional-aggregation query.
    const [openingCashRows, totalsRow] = await Promise.all([
      // Opening cash balance: bank accounts posted before the period start
      HAS_SUBTYPE
        ? sql`
            SELECT COALESCE(SUM(
              CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
            ), 0)::numeric as balance
            FROM gl_journal_lines jl
            JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
            JOIN gl_accounts ga ON ga.id = jl.gl_account_id
            WHERE ga.account_type = 'asset'
              AND ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])
              AND je.company_id = ${companyId}
              AND jl.company_id = ${companyId}::UUID
              AND je.status = 'posted'
              AND je.entry_date < ${startDate}
          `
        : sql`
            SELECT COALESCE(SUM(
              CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
            ), 0)::numeric as balance
            FROM gl_journal_lines jl
            JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
            JOIN gl_accounts ga ON ga.id = jl.gl_account_id
            WHERE ga.account_type = 'asset'
              AND ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])
              AND je.company_id = ${companyId}
              AND jl.company_id = ${companyId}::UUID
              AND je.status = 'posted'
              AND je.entry_date < ${startDate}
          `,

      // Single conditional-aggregation query replaces the previous 6 queries.
      // Signs preserve the exact semantics of the original code:
      //   net_income = (revenue credit-debit) - (expense debit-credit)
      //   ar_delta   = credit - debit  (positive = AR decreased = cash collected)
      //   ap_delta   = credit - debit  (positive = AP increased = more owed)
      //   investing  = credit - debit  (positive = asset sold)
      //   financing  = credit - debit  (positive = equity increased)
      sql`
        SELECT
          COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit END), 0)::numeric
          - COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit END), 0)::numeric
            AS net_income,
          COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${RECEIVABLE_SUBTYPES as string[]}::TEXT[]) THEN jl.credit - jl.debit END), 0)::numeric
            AS ar_delta,
          COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${PAYABLE_SUBTYPES as string[]}::TEXT[]) THEN jl.credit - jl.debit END), 0)::numeric
            AS ap_delta,
          COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${INVESTING_ASSET_SUBTYPES as string[]}::TEXT[]) THEN jl.credit - jl.debit END), 0)::numeric
            AS investing,
          COALESCE(SUM(CASE WHEN ga.account_type = 'equity'
            AND (ga.account_subtype IS NULL OR ga.account_subtype != 'retained_earnings')
            THEN jl.credit - jl.debit END), 0)::numeric
            AS financing
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND jl.company_id = ${companyId}::UUID
          AND ga.company_id = ${companyId}::UUID
          AND je.entry_date BETWEEN ${startDate} AND ${endDate}
      `,
    ]);

    const openingBalance = Number((openingCashRows as Record<string, unknown>[])[0]?.balance ?? 0);
    const totals = (totalsRow as Record<string, unknown>[])[0] ?? {};

    const netIncome = Number(totals.net_income ?? 0);
    const arChangeVal = Number(totals.ar_delta ?? 0);
    const apChangeVal = Number(totals.ap_delta ?? 0);
    const investingChangeVal = Number(totals.investing ?? 0);
    const financingChangeVal = Number(totals.financing ?? 0);

    const operatingTotal = netIncome + arChangeVal + apChangeVal;
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
            { label: 'Net Income', amount: netIncome },
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

export default withAuth(withErrorHandler(withWriteAccess(handler)));
