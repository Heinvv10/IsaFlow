/**
 * GET /api/accounting/income-statement-xlsx
 * Streams an ExcelJS xlsx workbook of the Income Statement as an .xlsx download.
 */

import type { NextApiResponse } from 'next';
import ExcelJS from 'exceljs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { apiLogger } from '@/lib/logger';
import { getIncomeStatement } from '@/modules/accounting/services/reports/financialReportingService';

type Row = Record<string, unknown>;

const TEAL_ARGB = 'FF0D9488';
const WHITE_ARGB = 'FFFFFFFF';
const GREY_ARGB = 'FFF1F5F9';
const NUM_FMT = '#,##0.00';

function addTitleRows(
  ws: ExcelJS.Worksheet,
  title: string,
  periodLabel: string,
  today: string
) {
  ws.mergeCells('A1:D1');
  const titleCell = ws.getCell('A1');
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'left' };
  ws.getRow(1).height = 24;

  ws.mergeCells('A2:D2');
  const periodCell = ws.getCell('A2');
  periodCell.value = periodLabel;
  periodCell.font = { size: 11 };
  periodCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY_ARGB } };

  ws.mergeCells('A3:D3');
  const genCell = ws.getCell('A3');
  genCell.value = `Generated: ${today}`;
  genCell.font = { size: 10, italic: true };
  genCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY_ARGB } };

  ws.addRow([]);
}

function addHeaderRow(ws: ExcelJS.Worksheet) {
  const hdr = ws.addRow(['Section', 'Account Code', 'Account Name', 'Amount (R)']);
  hdr.eachCell(cell => {
    cell.font = { bold: true, color: { argb: WHITE_ARGB }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL_ARGB } };
    cell.alignment = { horizontal: 'center' };
    cell.border = { bottom: { style: 'thin' } };
  });
  hdr.getCell(4).alignment = { horizontal: 'right' };
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: 4 } };
  return hdr.number;
}

function addSectionHeader(ws: ExcelJS.Worksheet, label: string, color: string) {
  const row = ws.addRow([label, '', '', '']);
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: WHITE_ARGB }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  });
}

function addLineItem(ws: ExcelJS.Worksheet, section: string, code: string, name: string, amount: number) {
  const row = ws.addRow([section, code, name, amount]);
  row.getCell(4).numFmt = NUM_FMT;
  row.getCell(4).alignment = { horizontal: 'right' };
}

function addTotalRow(ws: ExcelJS.Worksheet, label: string, amount: number, bgArgb?: string) {
  const row = ws.addRow([label, '', '', amount]);
  row.eachCell(cell => {
    cell.font = { bold: true };
    cell.border = { top: { style: 'thin' } };
    if (bgArgb) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    }
  });
  row.getCell(4).numFmt = NUM_FMT;
  row.getCell(4).alignment = { horizontal: 'right' };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end('Method Not Allowed');
    return;
  }

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const { period_start: start, period_end: end, cost_centre_id: ccId } = req.query as Record<string, string>;

  if (!start || !end) {
    res.status(400).json({ success: false, error: 'period_start and period_end are required' });
    return;
  }

  apiLogger.info({ companyId, start, end }, 'Income statement xlsx export requested');

  const [companyRows, report] = await Promise.all([
    sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<Row[]>,
    getIncomeStatement(companyId, start, end, ccId ? { costCentreId: ccId } : {}),
  ]);

  const companyName = String(companyRows[0]?.name ?? 'Company');
  const today = new Date().toISOString().slice(0, 10);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ISAFlow';
  wb.created = new Date();

  const ws = wb.addWorksheet('Income Statement');

  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 35;
  ws.getColumn(4).width = 16;

  addTitleRows(ws, `${companyName} — Income Statement`, `Period: ${start} to ${end}`, today);
  addHeaderRow(ws);

  // Revenue
  addSectionHeader(ws, 'Revenue', TEAL_ARGB);
  for (const item of report.revenue) {
    addLineItem(ws, 'Revenue', item.accountCode, item.accountName, item.amount);
  }
  ws.addRow([]);
  addTotalRow(ws, 'Total Revenue', report.totalRevenue);

  // Cost of Sales
  if (report.costOfSales.length > 0) {
    ws.addRow([]);
    addSectionHeader(ws, 'Cost of Sales', 'FFEA580C');
    for (const item of report.costOfSales) {
      addLineItem(ws, 'Cost of Sales', item.accountCode, item.accountName, item.amount);
    }
    ws.addRow([]);
    addTotalRow(ws, 'Total Cost of Sales', report.totalCostOfSales);
  }

  // Gross Profit
  ws.addRow([]);
  addTotalRow(ws, 'Gross Profit', report.grossProfit, TEAL_ARGB);
  const gpMarginRow = ws.addRow([
    'Gross Margin %', '', '',
    report.totalRevenue > 0 ? ((report.grossProfit / report.totalRevenue) * 100).toFixed(1) + '%' : 'N/A',
  ]);
  gpMarginRow.getCell(4).alignment = { horizontal: 'right' };

  // Operating Expenses
  ws.addRow([]);
  addSectionHeader(ws, 'Operating Expenses', 'FFDC2626');
  for (const item of report.operatingExpenses) {
    addLineItem(ws, 'Operating Expenses', item.accountCode, item.accountName, item.amount);
  }
  ws.addRow([]);
  addTotalRow(ws, 'Total Operating Expenses', report.totalOperatingExpenses);

  // Net Profit
  ws.addRow([]);
  const npBg = report.netProfit >= 0 ? TEAL_ARGB : 'FFDC2626';
  const npRow = ws.addRow(['Net Profit / (Loss)', '', '', report.netProfit]);
  npRow.eachCell(cell => {
    cell.font = { bold: true, size: 13, color: { argb: WHITE_ARGB } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: npBg } };
  });
  npRow.getCell(4).numFmt = NUM_FMT;
  npRow.getCell(4).alignment = { horizontal: 'right' };

  const nmRow = ws.addRow([
    'Net Margin %', '', '',
    report.totalRevenue > 0 ? ((report.netProfit / report.totalRevenue) * 100).toFixed(1) + '%' : 'N/A',
  ]);
  nmRow.getCell(4).alignment = { horizontal: 'right' };

  const filename = `income-statement-${start}-to-${end}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
}

export default withAuth(withErrorHandler(handler));
