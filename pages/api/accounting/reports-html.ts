/**
 * Report HTML Export API
 * POST /api/accounting/reports-html
 * Body: { type: 'board'|'management'|'monthly', from: string, to: string }
 * Returns a rendered HTML string for user-facing download.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { incomeStatementPackRows } from '@/modules/accounting/services/reports/incomeStatementPackRows';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import {
  getFinancialFigures,
  totalEquity,
  unclassifiedWarning,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { buildDataQualityNotices } from '@/modules/accounting/services/reports/dataQualityNotices';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
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

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkReportRateLimit(companyId, 'reports-html'))) {
    log.warn('Report HTML export rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report exports. Please try again shortly.');
  }

  const { type, from, to } = req.body as { type: string; from: string; to: string };

  if (!type || !VALID_TYPES.includes(type as PackType)) {
    return apiResponse.badRequest(res, `type must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if (!from || !to) {
    return apiResponse.badRequest(res, 'from and to dates are required');
  }
  // M4: from/to are interpolated into the returned text/html document and the
  // Content-Disposition filename — constrain to ISO dates so they cannot carry
  // markup (reflected XSS).
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be ISO dates (YYYY-MM-DD)');
  }

  const [figures, companyRow] = await Promise.all([
    getFinancialFigures(companyId, from, to),
    getCompanyName(companyId),
  ]);

  const { period, cumulative } = figures;
  const netProfit = period.netProfit;

  const data: ReportPackInput = {
    companyName: companyRow?.name || 'Company',
    period: `${from} to ${to}`,
    revenue: period.revenue,
    costOfSales: period.costOfSales,
    operatingExpenses: period.operatingExpenses,
    netProfit,
    totalAssets: cumulative.totalAssets,
    totalLiabilities: cumulative.totalLiabilities,
    totalEquity: totalEquity(figures),
    currentAssets: cumulative.currentAssets,
    currentLiabilities: cumulative.currentLiabilities,
    cash: cumulative.cash,
    accountsReceivable: cumulative.accountsReceivable,
    accountsPayable: cumulative.accountsPayable,
    inventory: cumulative.inventory,
  };

  const pack = buildReportPack(type as PackType, data, from, to);
  // This endpoint returns a document, not JSON — the caveat has to be IN the
  // document or nobody sees it.
  const notices = buildDataQualityNotices({
    unclassifiedAccounts: unclassifiedWarning(cumulative),
  });
  const html = buildReportHtml(pack, type as PackType, from, to, notices);

  log.info('HTML report generated', { companyId, type, from, to }, 'accounting');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="report-pack-${type}-${from}-to-${to}.html"`,
  );
  res.send(html);
}

async function getCompanyName(companyId: string): Promise<Row | null> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId} LIMIT 1`) as Row[];
  return rows[0] || null;
}

// ── HTML generation ───────────────────────────────────────────────────────────

/** Escape DB-derived strings before HTML interpolation (stored/reflected XSS). */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const fmtZAR = (v: unknown): string => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtPct = (v: unknown): string => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return `${n.toFixed(1)}%`;
};

/**
 * Exported so the WIRING is testable. The row list it renders is tested, but a
 * future edit here — a `.filter()` on the rows, a dropped `<td>` — would not be
 * caught by that: the list would still be right and the document still wrong.
 */
export function renderSectionHtml(section: PackSection): string {
  const d = section.data;

  let rows = '';

  switch (section.type) {
    case 'income_statement':
      // One row list, shared with the PDF pack — see incomeStatementPackRows.
      rows = incomeStatementPackRows(d as Record<string, unknown>)
        .map(r => `<tr><td>${r.label}</td><td class="num">${fmtZAR(r.amount)}</td><td class="num muted">${r.margin === undefined ? '' : fmtPct(r.margin)}</td></tr>`)
        .join('');
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
        return `<tr><td>${escapeHtml(item.name)}</td><td class="num">${typeof item.value === 'number' ? item.value.toFixed(2) : escapeHtml(String(item.value))}</td><td class="num">${typeof item.target === 'number' ? item.target.toFixed(2) : '—'}</td><td><span class="${cls}">${escapeHtml(item.status.toUpperCase())}</span></td></tr>`;
      }).join('');
      return tableHtml(['KPI', 'Actual', 'Target', 'Status'], rows);
    }

    case 'commentary':
      return `<p class="commentary">${escapeHtml(String(d.summary ?? ''))}</p>`;

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
  notices: string[] = [],
): string {
  const packLabel = type === 'board' ? 'Board Pack' : type === 'management' ? 'Management Pack' : 'Monthly Pack';
  const generatedAt = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });

  // escapeHtml: notices interpolate account counts and amounts we derived, but
  // the type labels come from the same path as DB-derived strings elsewhere.
  const noticesHtml = notices.length === 0 ? '' : `
    <section class="data-quality">
      <h2>These figures rest on an assumption</h2>
      <ul>${notices.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
    </section>`;

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
  <title>${escapeHtml(pack.companyName)} — ${packLabel}</title>
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
    .data-quality { border: 1px solid #d9a441; background: #fdf6e6; padding: 12px 16px; margin-bottom: 20px; border-radius: 6px; }
    .data-quality h2 { font-size: 14px; margin: 0 0 6px; }
    .data-quality ul { margin: 0; padding-left: 18px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Financial Report Pack</h1>
    <div class="meta">${packLabel} &bull; Generated ${generatedAt}</div>
  </div>
  <div class="company-name">${escapeHtml(pack.companyName)}</div>
  <div class="period-info">Period: ${from} to ${to}</div>
  <div class="content">
    ${noticesHtml}
    ${sectionsHtml}
  </div>
  <div class="footer">
    <span>Generated by IsaFlow</span>
    <span>${escapeHtml(pack.companyName)} &mdash; ${packLabel}</span>
  </div>
</body>
</html>`;
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
