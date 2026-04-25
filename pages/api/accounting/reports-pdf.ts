/**
 * Report PDF Export API
 * POST /api/accounting/reports-pdf
 * Body: { type: 'board'|'management'|'monthly', from: string, to: string }
 *
 * Generates a real PDF using jsPDF + jspdf-autotable with company branding.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  buildReportPack,
  type PackType,
  type PackSection,
  type ReportPackInput,
} from '@/modules/accounting/services/reports/reportPackService';
import {
  fmtZAR,
  TEAL,
  renderPageFooters,
  hexToRgb,
  getCompanyDetailsFromCompany,
  type CompanyDetails,
} from '@/modules/accounting/services/core/pdfShared';
import { getIncomeStatement, getBalanceSheet } from '@/modules/accounting/services/reports/financialReportingService';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsPDFDoc = any;

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const { type, from, to } = req.body as { type: string; from: string; to: string };

  if (!type || !VALID_TYPES.includes(type as PackType)) {
    return apiResponse.badRequest(res, `type must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if (!from || !to) {
    return apiResponse.badRequest(res, 'from and to dates are required');
  }

  const [isReport, bsReport, company] = await Promise.all([
    getIncomeStatement(companyId, from, to, {}),
    getBalanceSheet(companyId, to),
    getCompanyDetailsFromCompany(companyId),
  ]);

  const revenue = isReport.totalRevenue;
  const costOfSales = isReport.totalCostOfSales;
  const operatingExpenses = isReport.totalOperatingExpenses;
  const netProfit = isReport.netProfit;

  const data: ReportPackInput = {
    companyName: company.name,
    period: `${from} to ${to}`,
    revenue,
    costOfSales,
    operatingExpenses,
    netProfit,
    totalAssets: bsReport.totalAssets,
    totalLiabilities: bsReport.totalLiabilities,
    totalEquity: bsReport.totalEquity,
    currentAssets: bsReport.assets
      .filter(a => a.accountCode?.startsWith('1') && Number(a.accountCode) < 1200)
      .reduce((s, a) => s + a.balance, 0),
    currentLiabilities: bsReport.liabilities
      .filter(a => a.accountCode?.startsWith('2') && Number(a.accountCode) < 2200)
      .reduce((s, a) => s + a.balance, 0),
    cash: 0,
    accountsReceivable: 0,
    accountsPayable: 0,
    inventory: 0,
  };

  const pack = buildReportPack(type as PackType, data, from, to);

  log.info('Generating PDF report pack', { companyId, type, from, to }, 'accounting');

  const pdfBuffer = await buildReportPackPdf(pack, type as PackType, from, to, company);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="report-pack-${type}-${from}-to-${to}.pdf"`,
  );
  res.send(pdfBuffer);
}

// ── PDF generation ────────────────────────────────────────────────────────────
const n = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v ?? '0')));
const pct = (v: unknown): string => `${Number(n(v)).toFixed(1)}%`;
const getPrimaryRgb = (c: string) => { try { return hexToRgb(c); } catch { return TEAL; } };

function renderSectionHeader(
  doc: JsPDFDoc,
  title: string,
  y: number,
  pageW: number,
  margin: number,
  color: { r: number; g: number; b: number },
): number {
  doc.setFillColor(color.r, color.g, color.b);
  doc.rect(margin, y, pageW - margin * 2, 7, 'F');
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
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

function renderSection(
  doc: JsPDFDoc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  section: PackSection,
  pageW: number,
  pageH: number,
  margin: number,
  color: { r: number; g: number; b: number },
): number {
  const prevY: number = doc.lastAutoTable?.finalY ?? 20;
  if (prevY > pageH - 60) {
    doc.addPage();
    doc.lastAutoTable = { finalY: 20 };
  }
  const startY: number = (doc.lastAutoTable?.finalY ?? 20) + 14;

  const y = renderSectionHeader(doc, section.title, startY, pageW, margin, color);
  const d = section.data;

  switch (section.type) {
    case 'income_statement':
      return renderTable(
        doc,
        autoTable,
        [['Item', 'Amount', 'Margin']],
        [
          ['Revenue', fmtZAR(n(d.revenue)), ''],
          ['Cost of Sales', fmtZAR(n(d.costOfSales)), ''],
          ['Gross Profit', fmtZAR(n(d.grossProfit)), pct(d.grossMargin)],
          ['Operating Expenses', fmtZAR(n(d.operatingExpenses)), ''],
          ['Net Profit', fmtZAR(n(d.netProfit)), pct(d.netMargin)],
        ],
        y,
        margin,
      );

    case 'balance_sheet':
      return renderTable(
        doc,
        autoTable,
        [['Item', 'Amount']],
        [
          ['Current Assets', fmtZAR(n(d.currentAssets))],
          ['Total Assets', fmtZAR(n(d.totalAssets))],
          ['Current Liabilities', fmtZAR(n(d.currentLiabilities))],
          ['Total Liabilities', fmtZAR(n(d.totalLiabilities))],
          ['Total Equity', fmtZAR(n(d.totalEquity))],
        ],
        y,
        margin,
      );

    case 'cash_flow':
      return renderTable(
        doc,
        autoTable,
        [['Item', 'Amount']],
        [
          ['Operating Cash Flow', fmtZAR(n(d.operatingCashFlow))],
          ['Investing Cash Flow', fmtZAR(n(d.investingCashFlow))],
          ['Financing Cash Flow', fmtZAR(n(d.financingCashFlow))],
          ['Net Cash Flow', fmtZAR(n(d.netCashFlow))],
          ['Opening Cash', fmtZAR(n(d.openingCash))],
          ['Closing Cash', fmtZAR(n(d.closingCash))],
        ],
        y,
        margin,
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
      doc.lastAutoTable = { finalY: y + lines.length * 5 };
      return y + lines.length * 5 + 8;
    }

    default:
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
  company: CompanyDetails,
): Promise<Buffer> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const color = getPrimaryRgb(company.primaryColor);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 14;

  // Cover page — full-width header in company primary colour
  doc.setFillColor(color.r, color.g, color.b);
  doc.rect(0, 0, PAGE_W, 45, 'F');

  doc.setFontSize(20); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
  doc.text(company.name, MARGIN, 18);
  doc.setFontSize(12); doc.setFont('helvetica', 'normal');
  doc.text(`${type.charAt(0).toUpperCase() + type.slice(1)} Report`, MARGIN, 30);

  // Company details below header
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  let detailY = 55;
  if (company.address) { doc.text(company.address, MARGIN, detailY); detailY += 6; }
  if (company.vatNumber) { doc.text(`VAT: ${company.vatNumber}`, MARGIN, detailY); detailY += 6; }
  if (company.phone) { doc.text(company.phone, MARGIN, detailY); detailY += 6; }
  detailY += 4;
  doc.setTextColor(80, 80, 80);
  doc.text(`Period: ${from} to ${to}`, MARGIN, detailY); detailY += 6;
  doc.text(`Generated: ${new Date().toLocaleDateString('en-ZA')}`, MARGIN, detailY); detailY += 8;

  // Horizontal rule in primary colour
  doc.setDrawColor(color.r, color.g, color.b);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, detailY, PAGE_W - MARGIN, detailY);

  doc.addPage();
  (doc as JsPDFDoc).lastAutoTable = { finalY: 20 };
  for (const section of pack.sections) renderSection(doc, autoTable, section, PAGE_W, PAGE_H, MARGIN, color);
  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN);
  return Buffer.from(doc.output('arraybuffer'));
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
