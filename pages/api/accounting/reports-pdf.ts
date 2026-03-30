/**
 * Report PDF Export API
 * POST /api/accounting/reports-pdf
 * Body: { type: 'board'|'management'|'monthly', from: string, to: string }
 *
 * NOTE: Returns JSON placeholder — PDF generation requires a PDF library (e.g. puppeteer/pdfkit).
 * Install puppeteer or @react-pdf/renderer to generate actual PDF buffers.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  buildReportPack,
  type PackType,
  type ReportPackInput,
} from '@/modules/accounting/services/reportPackService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const { type, from, to } = req.body as { type: string; from: string; to: string };

  if (!type || !VALID_TYPES.includes(type as PackType)) {
    return apiResponse.badRequest(res, `type must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if (!from || !to) {
    return apiResponse.badRequest(res, 'from and to dates are required');
  }

  const [pnlRow, balancesRow, companyRow] = await Promise.all([
    getPnLTotals(companyId, from, to),
    getBalanceSheet(companyId, to),
    getCompanyName(companyId),
  ]);

  const revenue = parseFloat(pnlRow?.revenue || '0');
  const costOfSales = parseFloat(pnlRow?.cost_of_sales || '0');
  const operatingExpenses = parseFloat(pnlRow?.operating_expenses || '0');
  const netProfit = revenue - costOfSales - operatingExpenses;

  const data: ReportPackInput = {
    companyName: companyRow?.name || 'Company',
    period: `${from} to ${to}`,
    revenue,
    costOfSales,
    operatingExpenses,
    netProfit,
    totalAssets: parseFloat(balancesRow?.total_assets || '0'),
    totalLiabilities: parseFloat(balancesRow?.total_liabilities || '0'),
    totalEquity: parseFloat(balancesRow?.total_equity || '0') + netProfit,
    currentAssets: parseFloat(balancesRow?.current_assets || '0'),
    currentLiabilities: parseFloat(balancesRow?.current_liabilities || '0'),
    cash: parseFloat(balancesRow?.cash || '0'),
    accountsReceivable: parseFloat(balancesRow?.accounts_receivable || '0'),
    accountsPayable: parseFloat(balancesRow?.accounts_payable || '0'),
    inventory: 0,
  };

  const pack = buildReportPack(type as PackType, data, from, to);

  log.info('PDF report requested', { companyId, type, from, to }, 'accounting');

  // MOCK: PDF library not installed. Return structured JSON data.
  // To generate actual PDF: install puppeteer or @react-pdf/renderer and render pack sections.
  return apiResponse.success(res, {
    pdfAvailable: false,
    message: 'PDF generation placeholder — install a PDF library to enable binary output',
    pack,
    downloadUrl: null,
  });
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

async function getCompanyName(companyId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT name FROM companies WHERE id = ${companyId} LIMIT 1
  `) as Row[];
  return rows[0] || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
