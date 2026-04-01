/**
 * Executive Summary API
 * GET /api/accounting/reports-executive-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  buildExecutiveSummary,
  type ExecutiveSummaryInput,
} from '@/modules/accounting/services/executiveSummaryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const from: string = (req.query.from as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]!;
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!;

  const [current, prior, balances, empCount] = await Promise.all([
    getPnLTotals(companyId, from, to),
    getPriorPnL(companyId, from, to),
    getBalanceSheet(companyId, to),
    getEmployeeCount(companyId),
  ]);

  const companyRow = (await sql`
    SELECT name FROM companies WHERE id = ${companyId} LIMIT 1
  `) as Row[];
  const companyName: string = companyRow[0]?.name || 'Company';

  const revenue = parseFloat(current?.revenue || '0');
  const costOfSales = parseFloat(current?.cost_of_sales || '0');
  const operatingExpenses = parseFloat(current?.operating_expenses || '0');
  const netProfit = revenue - costOfSales - operatingExpenses;

  const input: ExecutiveSummaryInput = {
    period: `${from} to ${to}`,
    companyName,
    revenue,
    costOfSales,
    operatingExpenses,
    netProfit,
    totalAssets: parseFloat(balances?.total_assets || '0'),
    totalLiabilities: parseFloat(balances?.total_liabilities || '0'),
    totalEquity: parseFloat(balances?.total_equity || '0') + netProfit,
    currentAssets: parseFloat(balances?.current_assets || '0'),
    currentLiabilities: parseFloat(balances?.current_liabilities || '0'),
    cash: parseFloat(balances?.cash || '0'),
    accountsReceivable: parseFloat(balances?.accounts_receivable || '0'),
    accountsPayable: parseFloat(balances?.accounts_payable || '0'),
    inventory: 0,
    priorRevenue: parseFloat(prior?.revenue || '0') || undefined,
    priorNetProfit: prior ? (() => {
      const pr = parseFloat(prior.revenue || '0');
      const pc = parseFloat(prior.cost_of_sales || '0');
      const po = parseFloat(prior.operating_expenses || '0');
      return pr - pc - po;
    })() : undefined,
  };

  const summary = buildExecutiveSummary(input, from, to);

  log.info('Executive summary generated', { companyId, from, to, employees: empCount }, 'accounting');

  return apiResponse.success(res, { summary, period: { from, to } });
}

async function getPnLTotals(companyId: string, from: string, to: string): Promise<Row | undefined> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_code >= '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as operating_expenses
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
  `) as Row[];
  return rows[0];
}

async function getPriorPnL(companyId: string, from: string, to: string): Promise<Row | null> {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const daysDiff = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
  const priorTo = new Date(fromDate.getTime() - 86400000).toISOString().split('T')[0]!;
  const priorFrom = new Date(fromDate.getTime() - (daysDiff + 1) * 86400000).toISOString().split('T')[0]!;

  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_code >= '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as operating_expenses
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date >= ${priorFrom}::date AND je.entry_date <= ${priorTo}::date
  `) as Row[];
  return rows[0] || null;
}

async function getBalanceSheet(companyId: string, to: string): Promise<Row | undefined> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '1%' THEN jl.debit - jl.credit ELSE 0 END), 0) as total_assets,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '2%' THEN jl.credit - jl.debit ELSE 0 END), 0) as total_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '3%' THEN jl.credit - jl.debit ELSE 0 END), 0) as total_equity,
      COALESCE(SUM(CASE WHEN ga.account_code >= '1100' AND ga.account_code < '1200' THEN jl.debit - jl.credit ELSE 0 END), 0) as current_assets,
      COALESCE(SUM(CASE WHEN ga.account_code >= '2100' AND ga.account_code < '2200' THEN jl.credit - jl.debit ELSE 0 END), 0) as current_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code = '1110' THEN jl.debit - jl.credit ELSE 0 END), 0) as cash,
      COALESCE(SUM(CASE WHEN ga.account_code = '1120' THEN jl.debit - jl.credit ELSE 0 END), 0) as accounts_receivable,
      COALESCE(SUM(CASE WHEN ga.account_code = '2110' THEN jl.credit - jl.debit ELSE 0 END), 0) as accounts_payable
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date <= ${to}::date
  `) as Row[];
  return rows[0];
}

async function getEmployeeCount(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int as count FROM employees WHERE company_id = ${companyId} AND status = 'active'
  `) as Row[];
  return rows[0]?.count || 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
