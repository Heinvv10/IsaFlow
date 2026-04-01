/**
 * Extended Financial Ratios API
 * GET /api/accounting/reports-extended-ratios?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reportingEngineService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const from: string = (req.query.from as string) || '2026-01-01';
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!

  const data = await buildFinancialData(companyId, from, to);
  const ratios = calculateExtendedRatios(data);

  return apiResponse.success(res, { period: { from, to }, ratios, financialData: data });
}

async function buildFinancialData(companyId: string, from: string, to: string): Promise<FinancialData> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Row = Record<string, any>;

  // Revenue & expense totals from journal lines
  const [totals] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_code >= '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as operating_expenses,
      COALESCE(SUM(CASE WHEN ga.account_code = '5800' THEN jl.debit - jl.credit ELSE 0 END), 0) as depreciation
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
  `) as Row[];

  // Balance sheet from cumulative journal lines up to 'to' date
  const [balances] = (await sql`
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

  // Employee count
  const [empCount] = (await sql`
    SELECT COUNT(*)::int as count FROM employees WHERE company_id = ${companyId} AND status = 'active'
  `) as Row[];

  const revenue = parseFloat(totals?.revenue || '0');
  const costOfSales = parseFloat(totals?.cost_of_sales || '0');
  const operatingExpenses = parseFloat(totals?.operating_expenses || '0');
  const netProfit = revenue - costOfSales - operatingExpenses;

  return {
    revenue,
    costOfSales,
    operatingExpenses,
    netProfit,
    totalAssets: parseFloat(balances?.total_assets || '0'),
    totalLiabilities: parseFloat(balances?.total_liabilities || '0'),
    totalEquity: parseFloat(balances?.total_equity || '0') + netProfit,
    currentAssets: parseFloat(balances?.current_assets || '0'),
    currentLiabilities: parseFloat(balances?.current_liabilities || '0'),
    inventory: 0,
    accountsReceivable: parseFloat(balances?.accounts_receivable || '0'),
    accountsPayable: parseFloat(balances?.accounts_payable || '0'),
    cash: parseFloat(balances?.cash || '0'),
    depreciation: parseFloat(totals?.depreciation || '0'),
    employeeCount: empCount?.count || 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
