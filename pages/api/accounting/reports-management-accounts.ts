/**
 * Management Accounts Report API
 * GET /api/accounting/reports-management-accounts
 *   ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD&format=json|summary
 *
 * Returns a combined report with P&L, Balance Sheet, and Cash Flow data
 * for the selected period, plus KPI summary metrics.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import {
  CASH_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  PAYABLE_SUBTYPES,
} from '@/modules/accounting/services/gl/accountClassification';

type Row = Record<string, unknown>;

async function getCashFlowSummary(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<{
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  netCashFlow: number;
  openingCash: number;
  closingCash: number;
}> {
  const [netIncomeRows, arRows, apRows, investingRows, financingRows, openingRows] =
    await Promise.all([
      sql`
        SELECT COALESCE(SUM(
          CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
               WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit
               ELSE 0 END
        ), 0)::numeric AS net_income
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
          AND je.entry_date >= ${startDate} AND je.entry_date <= ${endDate}
      ` as Promise<Row[]>,
      sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric AS change
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID AND ga.account_type = 'asset'
          AND ga.account_subtype = ANY(${RECEIVABLE_SUBTYPES as string[]}::TEXT[])
          AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
          AND je.entry_date >= ${startDate} AND je.entry_date <= ${endDate}
      ` as Promise<Row[]>,
      sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID AND ga.account_type = 'liability'
          AND ga.account_subtype = ANY(${PAYABLE_SUBTYPES as string[]}::TEXT[])
          AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
          AND je.entry_date >= ${startDate} AND je.entry_date <= ${endDate}
      ` as Promise<Row[]>,
      sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID AND ga.account_type = 'asset'
          -- COALESCE, not NOT(... = ANY ...): a NULL subtype makes that
          -- expression NULL, which would silently drop every unclassified
          -- asset from investing activities.
          AND COALESCE(ga.account_subtype, '') <> ALL(${RECEIVABLE_SUBTYPES as string[]}::TEXT[])
          AND COALESCE(ga.account_subtype, '') <> ALL(${CASH_SUBTYPES as string[]}::TEXT[])
          AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
          AND je.entry_date >= ${startDate} AND je.entry_date <= ${endDate}
      ` as Promise<Row[]>,
      sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS change
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID AND ga.account_type = 'equity'
          AND ga.account_subtype IS DISTINCT FROM 'retained_earnings'
          AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
          AND je.entry_date >= ${startDate} AND je.entry_date <= ${endDate}
      ` as Promise<Row[]>,
      sql`
        SELECT COALESCE(SUM(
          CASE WHEN ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])
               THEN jl.debit - jl.credit ELSE 0 END
        ), 0)::numeric AS balance
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID AND ga.account_type = 'asset'
          AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
          AND je.entry_date < ${startDate}
      ` as Promise<Row[]>,
    ]);

  const netIncome = Number(netIncomeRows[0]?.net_income ?? 0);
  const ar = Number(arRows[0]?.change ?? 0);
  const ap = Number(apRows[0]?.change ?? 0);
  const investing = Number(investingRows[0]?.change ?? 0);
  const financing = Number(financingRows[0]?.change ?? 0);
  const opening = Number(openingRows[0]?.balance ?? 0);

  const operatingCashFlow = netIncome + ar + ap;
  const netCashFlow = operatingCashFlow + investing + financing;

  return {
    operatingCashFlow,
    investingCashFlow: investing,
    financingCashFlow: financing,
    netCashFlow,
    openingCash: opening,
    closingCash: opening + netCashFlow,
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const { period_start, period_end } = req.query;
  if (!period_start || !period_end) {
    return apiResponse.badRequest(res, 'period_start and period_end are required');
  }

  const startDate = String(period_start);
  const endDate = String(period_end);

  try {
    const [pl, bs, cf, companyRows] = await Promise.all([
      getIncomeStatement(companyId, startDate, endDate),
      getBalanceSheet(companyId, endDate),
      getCashFlowSummary(companyId, startDate, endDate),
      sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<Row[]>,
    ]);

    const companyName = String(companyRows[0]?.name ?? 'Company');
    const revenue = pl.totalRevenue ?? 0;
    const grossProfit = pl.grossProfit ?? 0;
    const netProfit = pl.netProfit ?? 0;
    // Both margins are ON TURNOVER. `totalRevenue` is turnover only since the
    // B75 convergence — it no longer folds in other income — so gross margin is
    // now trading margin, which is what it was always labelled. Net margin
    // keeps the same denominator deliberately: a margin whose denominator moves
    // with non-trading income is not comparable period to period.
    const grossProfitPct = revenue !== 0 ? (grossProfit / revenue) * 100 : 0;
    const netProfitPct = revenue !== 0 ? (netProfit / revenue) * 100 : 0;

    const report = {
      companyName,
      periodStart: startDate,
      periodEnd: endDate,
      generatedAt: new Date().toISOString(),
      kpis: {
        revenue,
        grossProfit,
        grossProfitPct: Math.round(grossProfitPct * 100) / 100,
        netProfit,
        netProfitPct: Math.round(netProfitPct * 100) / 100,
        cashPosition: cf.closingCash,
        totalAssets: bs.totalAssets ?? 0,
        totalLiabilities: bs.totalLiabilities ?? 0,
        totalEquity: bs.totalEquity ?? 0,
      },
      incomeStatement: pl,
      balanceSheet: bs,
      cashFlow: cf,
    };

    return apiResponse.success(res, report);
  } catch (err) {
    log.error('Management accounts report failed', { error: err, companyId, startDate, endDate }, 'reports-management-accounts');
    return apiResponse.badRequest(res, 'Failed to generate management accounts report');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
