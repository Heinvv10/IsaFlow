/**
 * Report PDF Export API
 * POST /api/accounting/reports-pdf
 * Body: { type: 'board'|'management'|'monthly', from: string, to: string }
 *
 * Generates a real PDF using jsPDF + jspdf-autotable with IsaFlow TEAL branding.
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
import { fmtZAR, TEAL, renderPageFooters } from '@/modules/accounting/services/core/pdfShared';
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

  log.info('Generating PDF report pack', { companyId, type, from, to }, 'accounting');

  const pdfBuffer = await buildReportPackPdf(pack, type as PackType, from, to);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="report-pack-${type}-${from}-to-${to}.pdf"`,
  );
  res.send(pdfBuffer);
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

// ── PDF generation ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsPDFDoc = any;
const n = (v: unknown): number => typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
const pct = (v: unknown): string => `${Number(n(v)).toFixed(1)}%`;

function renderSectionHeader(doc: JsPDFDoc, title: string, y: number, pageW: number, margin: number): number {
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
  doc.rect(margin, y, pageW - margin * 2, 7, 'F');
  doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(title.toUpperCase(), margin + 3, y + 5);
  doc.setTextColor(30, 30, 30);
  return y + 12;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderTable(doc: JsPDFDoc, autoTable: any, head: string[][], body: string[][], startY: number, margin: number): number {
  autoTable(doc, {
    head,
    body,
    startY,
    margin: { left: margin, right: margin },
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [240, 253, 250], textColor: [20, 184, 166], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    columnStyles: { 0: { fontStyle: 'bold' } },
  });
  return (doc.lastAutoTable?.finalY ?? startY) + 8;
}

function renderSection(doc: JsPDFDoc, autoTable: any, section: PackSection, pageW: number, pageH: number, margin: number): number {
  const prevY: number = doc.lastAutoTable?.finalY ?? 20;
  if (prevY > pageH - 60) {
    doc.addPage();
    doc.lastAutoTable = { finalY: 20 };
  }
  const startY: number = (doc.lastAutoTable?.finalY ?? 20) + 14;

  let y = renderSectionHeader(doc, section.title, startY, pageW, margin);
  const d = section.data;

  switch (section.type) {
    case 'income_statement':
      return renderTable(doc, autoTable,
        [['Item', 'Amount', 'Margin']],
        [
          ['Revenue', fmtZAR(n(d.revenue)), ''],
          ['Cost of Sales', fmtZAR(n(d.costOfSales)), ''],
          ['Gross Profit', fmtZAR(n(d.grossProfit)), pct(d.grossMargin)],
          ['Operating Expenses', fmtZAR(n(d.operatingExpenses)), ''],
          ['Net Profit', fmtZAR(n(d.netProfit)), pct(d.netMargin)],
        ],
        y, margin,
      );

    case 'balance_sheet':
      return renderTable(doc, autoTable,
        [['Item', 'Amount']],
        [
          ['Current Assets', fmtZAR(n(d.currentAssets))],
          ['Total Assets', fmtZAR(n(d.totalAssets))],
          ['Current Liabilities', fmtZAR(n(d.currentLiabilities))],
          ['Total Liabilities', fmtZAR(n(d.totalLiabilities))],
          ['Total Equity', fmtZAR(n(d.totalEquity))],
        ],
        y, margin,
      );

    case 'cash_flow':
      return renderTable(doc, autoTable,
        [['Item', 'Amount']],
        [
          ['Operating Cash Flow', fmtZAR(n(d.operatingCashFlow))],
          ['Investing Cash Flow', fmtZAR(n(d.investingCashFlow))],
          ['Financing Cash Flow', fmtZAR(n(d.financingCashFlow))],
          ['Net Cash Flow', fmtZAR(n(d.netCashFlow))],
          ['Opening Cash', fmtZAR(n(d.openingCash))],
          ['Closing Cash', fmtZAR(n(d.closingCash))],
        ],
        y, margin,
      );

    case 'ratios': {
      const ratioRows = Object.entries(d as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [
          k.replace(/([A-Z])/g, ' $1').trim(),
          typeof v === 'number' ? v.toFixed(2) : String(v),
        ]);
      return renderTable(doc, autoTable, [['Ratio', 'Value']], ratioRows, y, margin);
    }

    case 'kpis': {
      const items = (d.scorecard as KPIScorecardItem[]) ?? [];
      const kpiRows = items.map(item => [
        item.name,
        typeof item.value === 'number' ? item.value.toFixed(2) : String(item.value ?? '—'),
        typeof item.target === 'number' ? item.target.toFixed(2) : '—',
        item.status.toUpperCase(),
      ]);
      return renderTable(doc, autoTable, [['KPI', 'Actual', 'Target', 'Status']], kpiRows, y, margin);
    }

    case 'commentary': {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      const text = String(d.summary ?? '');
      const lines: string[] = doc.splitTextToSize(text, pageW - margin * 2);
      doc.text(lines, margin, y);
      // Update lastAutoTable stub so next section can read finalY
      doc.lastAutoTable = { finalY: y + lines.length * 5 };
      return y + lines.length * 5 + 8;
    }

    default:
      // waterfall / trends — skip if no meaningful data
      doc.setFontSize(8);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(120, 120, 120);
      doc.text('Data not available for this section.', margin, y);
      doc.lastAutoTable = { finalY: y + 6 };
      return y + 14;
  }
}

async function buildReportPackPdf(
  pack: { companyName: string; period: string; sections: PackSection[] },
  type: PackType,
  from: string,
  to: string,
): Promise<Buffer> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 14;
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
  doc.rect(0, 0, PAGE_W, 40, 'F');

  doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
  doc.text('Financial Report Pack', MARGIN, 18);
  doc.setFontSize(11); doc.setFont('helvetica', 'normal');
  doc.text(`${type.charAt(0).toUpperCase() + type.slice(1)} Report`, MARGIN, 28);
  doc.setTextColor(30, 30, 30); doc.setFontSize(13); doc.setFont('helvetica', 'bold');
  doc.text(pack.companyName, MARGIN, 55);
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
  doc.text(`Period: ${from} to ${to}`, MARGIN, 63);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-ZA')}`, MARGIN, 69);
  doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b); doc.setLineWidth(0.5);
  doc.line(MARGIN, 74, PAGE_W - MARGIN, 74);

  doc.addPage();
  (doc as JsPDFDoc).lastAutoTable = { finalY: 20 };

  for (const section of pack.sections) {
    renderSection(doc, autoTable, section, PAGE_W, PAGE_H, MARGIN);
  }

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN);

  return Buffer.from(doc.output('arraybuffer'));
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
