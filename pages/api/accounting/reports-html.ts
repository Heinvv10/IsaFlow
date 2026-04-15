/**
 * Report HTML Export API
 * POST /api/accounting/reports-html
 * Body: { type: 'board'|'management'|'monthly', from: string, to: string }
 * Returns a rendered HTML string for user-facing download.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  buildReportPack,
  type PackType,
  type PackSection,
  type ReportPackInput,
} from '@/modules/accounting/services/reports/reportPackService';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';

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
    inventory: parseFloat(balancesRow?.inventory || '0'),
  };

  const pack = buildReportPack(type as PackType, data, from, to);
  const html = buildReportHtml(pack, type as PackType, from, to);

  log.info('HTML report generated', { companyId, type, from, to }, 'accounting');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="report-pack-${type}-${from}-to-${to}.html"`,
  );
  res.send(html);
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
    WHERE je.company_id = ${companyId} AND jl.company_id = ${companyId}::UUID AND je.status = 'posted'
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
      COALESCE(SUM(CASE WHEN ga.account_code = '2110' THEN jl.credit - jl.debit ELSE 0 END), 0) as accounts_payable,
      COALESCE(SUM(CASE WHEN ga.account_code = '1130' THEN jl.debit - jl.credit ELSE 0 END), 0) as inventory
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND jl.company_id = ${companyId}::UUID AND je.status = 'posted'
      AND je.entry_date <= ${to}::date
  `) as Row[];
  return rows[0];
}

async function getCompanyName(companyId: string): Promise<Row | null> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId} LIMIT 1`) as Row[];
  return rows[0] || null;
}

// ── HTML generation ───────────────────────────────────────────────────────────

const fmtZAR = (v: unknown): string => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtPct = (v: unknown): string => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return `${n.toFixed(1)}%`;
};

function renderSectionHtml(section: PackSection): string {
  const d = section.data;

  let rows = '';

  switch (section.type) {
    case 'income_statement':
      rows = [
        ['Revenue', fmtZAR(d.revenue), ''],
        ['Cost of Sales', fmtZAR(d.costOfSales), ''],
        ['Gross Profit', fmtZAR(d.grossProfit), fmtPct(d.grossMargin)],
        ['Operating Expenses', fmtZAR(d.operatingExpenses), ''],
        ['Net Profit', fmtZAR(d.netProfit), fmtPct(d.netMargin)],
      ].map(([l, v, m]) => `<tr><td>${l}</td><td class="num">${v}</td><td class="num muted">${m}</td></tr>`).join('');
      return tableHtml(['Item', 'Amount', 'Margin'], rows);

    case 'balance_sheet':
      rows = [
        ['Current Assets', fmtZAR(d.currentAssets)],
        ['Total Assets', fmtZAR(d.totalAssets)],
        ['Current Liabilities', fmtZAR(d.currentLiabilities)],
        ['Total Liabilities', fmtZAR(d.totalLiabilities)],
        ['Total Equity', fmtZAR(d.totalEquity)],
        ['Cash', fmtZAR(d.cash)],
        ['Accounts Receivable', fmtZAR(d.accountsReceivable)],
        ['Accounts Payable', fmtZAR(d.accountsPayable)],
      ].map(([l, v]) => `<tr><td>${l}</td><td class="num">${v}</td></tr>`).join('');
      return tableHtml(['Item', 'Amount'], rows);

    case 'cash_flow':
      rows = [
        ['Operating Cash Flow', fmtZAR(d.operatingCashFlow)],
        ['Investing Cash Flow', fmtZAR(d.investingCashFlow)],
        ['Financing Cash Flow', fmtZAR(d.financingCashFlow)],
        ['Net Cash Flow', fmtZAR(d.netCashFlow)],
        ['Opening Cash', fmtZAR(d.openingCash)],
        ['Closing Cash', fmtZAR(d.closingCash)],
      ].map(([l, v]) => `<tr><td>${l}</td><td class="num">${v}</td></tr>`).join('');
      return tableHtml(['Item', 'Amount'], rows);

    case 'ratios':
      rows = Object.entries(d as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .slice(0, 20)
        .map(([k, v]) => `<tr><td>${k.replace(/([A-Z])/g, ' $1').trim()}</td><td class="num">${typeof v === 'number' ? v.toFixed(2) : String(v)}</td></tr>`)
        .join('');
      return tableHtml(['Ratio', 'Value'], rows);

    case 'kpis': {
      const items = (d.scorecard as KPIScorecardItem[]) ?? [];
      rows = items.map(item => {
        const cls = item.status === 'green' ? 'status-green' : item.status === 'amber' ? 'status-amber' : 'status-red';
        return `<tr><td>${item.name}</td><td class="num">${typeof item.value === 'number' ? item.value.toFixed(2) : item.value}</td><td class="num">${typeof item.target === 'number' ? item.target.toFixed(2) : '—'}</td><td><span class="${cls}">${item.status.toUpperCase()}</span></td></tr>`;
      }).join('');
      return tableHtml(['KPI', 'Actual', 'Target', 'Status'], rows);
    }

    case 'commentary':
      return `<p class="commentary">${String(d.summary ?? '')}</p>`;

    default:
      return `<p class="muted"><em>Section data not available.</em></p>`;
  }
}

function tableHtml(headers: string[], bodyRows: string): string {
  const head = headers.map(h => `<th>${h}</th>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function buildReportHtml(
  pack: { companyName: string; period: string; sections: PackSection[] },
  type: PackType,
  from: string,
  to: string,
): string {
  const packLabel = type === 'board' ? 'Board Pack' : type === 'management' ? 'Management Pack' : 'Monthly Pack';
  const generatedAt = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });

  const sectionsHtml = pack.sections.map(section => `
    <section>
      <h2>${section.title}</h2>
      ${renderSectionHtml(section)}
    </section>
  `).join('\n');

  return `<!DOCTYPE html>
<html lang="en-ZA">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pack.companyName} — ${packLabel}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; }
    .header { background: #14b8a6; color: #fff; padding: 28px 32px; }
    .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .header .meta { font-size: 12px; opacity: 0.85; }
    .company-name { padding: 20px 32px 0; font-size: 18px; font-weight: 700; color: #14b8a6; }
    .period-info { padding: 4px 32px 16px; font-size: 12px; color: #555; border-bottom: 2px solid #14b8a6; margin-bottom: 8px; }
    .content { padding: 16px 32px 32px; }
    section { margin-bottom: 28px; }
    section h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #fff; background: #14b8a6; padding: 6px 10px; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
    th { background: #f0fdf9; color: #14b8a6; font-weight: 700; font-size: 11px; padding: 7px 10px; text-align: left; border-bottom: 2px solid #14b8a6; }
    td { padding: 6px 10px; border-bottom: 1px solid #e5e7eb; font-size: 12px; }
    tr:nth-child(even) td { background: #f9fafb; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .muted { color: #6b7280; }
    .commentary { line-height: 1.6; color: #374151; padding: 10px 0; }
    .status-green { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #dcfce7; color: #16a34a; font-size: 11px; font-weight: 600; }
    .status-amber { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #fef9c3; color: #ca8a04; font-size: 11px; font-weight: 600; }
    .status-red   { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #fee2e2; color: #dc2626; font-size: 11px; font-weight: 600; }
    .footer { border-top: 1px solid #e5e7eb; padding: 12px 32px; font-size: 11px; color: #9ca3af; display: flex; justify-content: space-between; }
    @media print {
      .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      section h2 { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Financial Report Pack</h1>
    <div class="meta">${packLabel} &bull; Generated ${generatedAt}</div>
  </div>
  <div class="company-name">${pack.companyName}</div>
  <div class="period-info">Period: ${from} to ${to}</div>
  <div class="content">
    ${sectionsHtml}
  </div>
  <div class="footer">
    <span>Generated by IsaFlow</span>
    <span>${pack.companyName} &mdash; ${packLabel}</span>
  </div>
</body>
</html>`;
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
