/**
 * GET /api/accounting/balance-sheet-xlsx
 * Streams an ExcelJS xlsx workbook of the Balance Sheet as an .xlsx download.
 */

import type { NextApiResponse } from 'next';
import ExcelJS from 'exceljs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { apiLogger } from '@/lib/logger';
import { getBalanceSheet } from '@/modules/accounting/services/reports/financialReportingService';
import { apiResponse } from '@/lib/apiResponse';
import { isUuidParam } from '@/lib/validation';

type Row = Record<string, unknown>;

const WHITE_ARGB = 'FFFFFFFF';
const GREY_ARGB = 'FFF1F5F9';
const BLUE_ARGB = 'FF1D4ED8';
const AMBER_ARGB = 'FFB45309';
const PURPLE_ARGB = 'FF7E22CE';
const NUM_FMT = '#,##0.00';

function addTitleRows(
  ws: ExcelJS.Worksheet,
  title: string,
  asAtLabel: string,
  today: string
) {
  ws.mergeCells('A1:D1');
  const titleCell = ws.getCell('A1');
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'left' };
  ws.getRow(1).height = 24;

  ws.mergeCells('A2:D2');
  const asAtCell = ws.getCell('A2');
  asAtCell.value = asAtLabel;
  asAtCell.font = { size: 11 };
  asAtCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY_ARGB } };

  ws.mergeCells('A3:D3');
  const genCell = ws.getCell('A3');
  genCell.value = `Generated: ${today}`;
  genCell.font = { size: 10, italic: true };
  genCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY_ARGB } };

  ws.addRow([]);
}

function addHeaderRow(ws: ExcelJS.Worksheet, colHeader: string) {
  const hdr = ws.addRow(['Section', 'Account Code', 'Account Name', colHeader]);
  hdr.eachCell(cell => {
    cell.font = { bold: true, color: { argb: WHITE_ARGB }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = { bottom: { style: 'thin' } };
  });
  hdr.getCell(4).alignment = { horizontal: 'right' };
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: 4 } };
}

function addSectionHeader(ws: ExcelJS.Worksheet, label: string, colorArgb: string) {
  const row = ws.addRow([label, '', '', '']);
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: WHITE_ARGB }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorArgb } };
  });
}

function addLineItem(ws: ExcelJS.Worksheet, section: string, code: string, name: string, balance: number) {
  const row = ws.addRow([section, code, name, balance]);
  row.getCell(4).numFmt = NUM_FMT;
  row.getCell(4).alignment = { horizontal: 'right' };
}

function addTotalRow(ws: ExcelJS.Worksheet, label: string, amount: number, colorArgb?: string) {
  const row = ws.addRow([label, '', '', amount]);
  row.eachCell(cell => {
    cell.font = { bold: true };
    cell.border = { top: { style: 'thin' } };
    if (colorArgb) {
      cell.font = { bold: true, color: { argb: WHITE_ARGB } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorArgb } };
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
  const { as_at_date: asAt, cost_centre_id: ccId, business_unit_id: buId } = req.query;

  if (!asAt) {
    return apiResponse.badRequest(res, 'as_at_date is required');
  }
  if (ccId !== undefined && !isUuidParam(ccId)) {
    return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
  }
  if (buId !== undefined && !isUuidParam(buId)) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }

  const asAtDate = String(asAt);
  apiLogger.info({ companyId, asAt: asAtDate }, 'Balance sheet xlsx export requested');

  const [companyRows, report] = await Promise.all([
    sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<Row[]>,
    getBalanceSheet(companyId, asAtDate, ccId ?? undefined, undefined, buId),
  ]);

  const companyName = String(companyRows[0]?.name ?? 'Company');
  const today = new Date().toISOString().slice(0, 10);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ISAFlow';
  wb.created = new Date();

  const ws = wb.addWorksheet('Balance Sheet');

  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 35;
  ws.getColumn(4).width = 16;

  addTitleRows(ws, `${companyName} — Balance Sheet`, `As at: ${asAtDate}`, today);
  addHeaderRow(ws, 'Balance (R)');

  // Assets
  addSectionHeader(ws, 'Assets', BLUE_ARGB);
  for (const item of report.assets) {
    addLineItem(ws, 'Assets', item.accountCode, item.accountName, item.balance);
  }
  ws.addRow([]);
  addTotalRow(ws, 'Total Assets', report.totalAssets, BLUE_ARGB);

  ws.addRow([]);

  // Equity
  addSectionHeader(ws, 'Equity', PURPLE_ARGB);
  for (const item of report.equity) {
    addLineItem(ws, 'Equity', item.accountCode, item.accountName, item.balance);
  }
  ws.addRow([]);
  addTotalRow(ws, 'Total Equity', report.totalEquity, PURPLE_ARGB);

  ws.addRow([]);

  // Liabilities
  addSectionHeader(ws, 'Liabilities', AMBER_ARGB);
  for (const item of report.liabilities) {
    addLineItem(ws, 'Liabilities', item.accountCode, item.accountName, item.balance);
  }
  ws.addRow([]);
  addTotalRow(ws, 'Total Liabilities', report.totalLiabilities, AMBER_ARGB);

  ws.addRow([]);

  // Total E + L
  const totalLE = report.totalLiabilities + report.totalEquity;
  addTotalRow(ws, 'Total Equity and Liabilities', totalLE);

  // Balance check
  const diff = Math.abs(report.totalAssets - totalLE);
  if (diff > 0.01) {
    const warnRow = ws.addRow([`Out of balance by R ${diff.toFixed(2)}`, '', '', '']);
    warnRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFDC2626' } };
    });
  }

  const filename = `balance-sheet-${asAtDate}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
}

export default withAuth(withErrorHandler(handler));
