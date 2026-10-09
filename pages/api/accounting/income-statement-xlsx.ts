/**
 * GET /api/accounting/income-statement-xlsx
 * Streams an ExcelJS xlsx workbook of the Income Statement as an .xlsx download.
 */

import type { NextApiResponse } from 'next';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';
import { reasonLabel } from '@/modules/accounting/services/reports/incomeStatementDisclosure';
import ExcelJS from 'exceljs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { apiLogger } from '@/lib/logger';
import {
  getIncomeStatement,
  getIncomeStatementByDimension,
} from '@/modules/accounting/services/reports/financialReportingService';
import type { IncomeStatementByDimension } from '@/modules/accounting/services/reports/incomeStatementService';
import {
  isDimensionGroupBy,
  isZeroResidual,
  type PnlBand,
} from '@/modules/accounting/services/reports/dimensionPnlService';
import { isUuidParam } from '@/lib/validation';

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

/**
 * Build the workbook from a report. Extracted from the handler so the RENDERED
 * output is testable: every band on this sheet could be deleted with the full
 * unit suite green, because nothing could reach the sheet without an HTTP
 * request. The AFS statement was missed the same way.
 */
export async function buildIncomeStatementWorkbook(
  report: IncomeStatementReport,
  companyName: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ISAFlow';
  wb.created = new Date();

  const ws = wb.addWorksheet('Income Statement');

  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 35;
  ws.getColumn(4).width = 16;

  addTitleRows(
    ws,
    `${companyName} — Income Statement`,
    `Period: ${report.periodStart} to ${report.periodEnd}`,
    today,
  );
  addHeaderRow(ws);

  // Revenue
  addSectionHeader(ws, 'Turnover', TEAL_ARGB);
  for (const item of report.revenue) {
    addLineItem(ws, 'Turnover', item.accountCode, item.accountName, item.amount);
  }
  ws.addRow([]);
  addTotalRow(ws, 'Total Turnover', report.totalRevenue);

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

  // An exported workbook leaves the app and carries the margin with no screen
  // to qualify it, so the caveat travels WITH the figure — directly beneath the
  // gross margin it applies to. See incomeStatementDisclosure.ts.
  if (report.subtypeDisclosure) {
    // Two rows, not their sum: summed they can exceed revenue itself, which is
    // a true bound and worthless to a reader. See incomeStatementDisclosure.ts.
    for (const [label, value] of [
      ['Expense that could be cost of sales (at most)', report.subtypeDisclosure.costOfSalesExposureAtMost],
      ['Revenue that could be other income (at most)', report.subtypeDisclosure.otherIncomeExposureAtMost],
    ] as const) {
      const r = ws.addRow(['Warning', '', label, value]);
      r.font = { bold: true, color: { argb: 'FFB45309' } };
      r.getCell(4).numFmt = '#,##0.00';
    }
    // Column A is the "Section" column and is inside `autoFilter` A5:D5, so it
    // is a filter value. Leaving it BLANK does not protect these rows — blank
    // is itself a value, and filtering Section to "Operating Expenses" hides
    // every blank-A row, i.e. the whole warning. So each row carries its own
    // "Warning" section label and filters under that, visibly. Text goes in
    // column C, amounts in D, matching `addLineItem`'s layout.
    for (const line of report.subtypeDisclosure.notices) {
      const noteRow = ws.addRow(['Warning', '', line]);
      noteRow.font = { italic: true, color: { argb: 'FFB45309' } };
    }
    for (const a of report.subtypeDisclosure.accounts) {
      const r = ws.addRow(['Warning', a.accountCode, `${a.accountName} — ${reasonLabel(a.reason)}`, a.amount]);
      r.font = { color: { argb: 'FFB45309' } };
      r.getCell(4).numFmt = '#,##0.00';
    }
    if (report.subtypeDisclosure.unnamedAccounts > 0) {
      ws.addRow(['Warning', '', `and ${report.subtypeDisclosure.unnamedAccounts} further affected account(s)`])
        .font = { italic: true, color: { argb: 'FFB45309' } };
    }
    // Disclosed accounts appear again in their own sections — revenue above
    // this block, expenses below it — so a column-D sum double-counts them.
    ws.addRow(['Warning', '', 'The amounts above are repeated elsewhere in this sheet — do not add them again.'])
      .font = { italic: true, color: { argb: 'FFB45309' } };
  }

  // Other Income — below gross profit, not inside turnover (B75)
  if (report.otherIncome.length > 0) {
    ws.addRow([]);
    addSectionHeader(ws, 'Other Income', 'FF0D9488');
    for (const item of report.otherIncome) {
      addLineItem(ws, 'Other Income', item.accountCode, item.accountName, item.amount);
    }
    ws.addRow([]);
    addTotalRow(ws, 'Total Other Income', report.totalOtherIncome);
  }

  // Operating Expenses
  ws.addRow([]);
  addSectionHeader(ws, 'Operating Expenses', 'FFDC2626');
  for (const item of report.operatingExpenses) {
    addLineItem(ws, 'Operating Expenses', item.accountCode, item.accountName, item.amount);
  }
  ws.addRow([]);
  addTotalRow(ws, 'Total Operating Expenses', report.totalOperatingExpenses);

  // Operating Profit
  ws.addRow([]);
  addTotalRow(ws, 'Operating Profit', report.operatingProfit, 'FF2563EB');

  // Other Expenses — finance cost, tax, other
  if (report.otherExpenses.length > 0) {
    ws.addRow([]);
    addSectionHeader(ws, 'Other Expenses', 'FFEA580C');
    for (const item of report.otherExpenses) {
      addLineItem(ws, 'Other Expenses', item.accountCode, item.accountName, item.amount);
    }
    ws.addRow([]);
    addTotalRow(ws, 'Total Other Expenses', report.totalOtherExpenses);
  }

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

  return wb;
}

const DIMENSION_LABEL: Record<IncomeStatementByDimension['groupBy'], string> = {
  cc1: 'CC1 (FNO)',
  cc2: 'CC2 (Project)',
  bu: 'Business Unit',
};

/**
 * The by-dimension matrix as its own sheet: accounts down, one column per
 * member plus Untagged and Total. Band subtotal rows come from the service's
 * folded columns, not from summing this sheet, and the residual row states the
 * tie to the ungrouped statement on the first sheet — it must read 0.00.
 */
export function addDimensionSheet(wb: ExcelJS.Workbook, matrix: IncomeStatementByDimension): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(`By ${matrix.groupBy.toUpperCase()}`);
  const members = matrix.members;
  const lastCol = 3 + members.length;

  ws.addRow([`Income Statement by ${DIMENSION_LABEL[matrix.groupBy]}`]).font = { bold: true, size: 14 };
  ws.addRow([`Period: ${matrix.periodStart} to ${matrix.periodEnd}`]);
  ws.addRow([]);
  const hdr = ws.addRow(['Section', 'Account Code', 'Account Name', ...members.map((m) => m.code), 'Total']);
  ws.addRow(['', '', '', ...members.map((m) => m.name), '']).font = { italic: true };
  hdr.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE_ARGB } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL_ARGB } };
  });
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 5 }];
  ws.getColumn(3).width = 35;

  const numRow = (values: Array<string | number>, bold = false) => {
    const row = ws.addRow(values);
    for (let c = 4; c <= lastCol + 1; c++) row.getCell(c).numFmt = NUM_FMT;
    if (bold) row.font = { bold: true };
    return row;
  };

  const sections: Array<[IncomeStatementByDimension['lines'][number]['band'], string, PnlBand]> = [
    ['revenue', 'Turnover', 'turnover'],
    ['costOfSales', 'Cost of Sales', 'costOfSales'],
    ['otherIncome', 'Other Income', 'otherIncome'],
    ['operatingExpenses', 'Operating Expenses', 'operatingExpenses'],
    ['otherExpenses', 'Other Expenses', 'otherExpenses'],
  ];
  const columnFor = (key: string) => matrix.columns.find((c) => c.key === key);
  const bandRow = (label: string, band: PnlBand) =>
    numRow([label, '', '', ...members.map((m) => columnFor(m.key)?.[band] ?? 0),
      matrix.columns.reduce((s, c) => s + c[band], 0)], true);

  for (const [band, label, pnlBand] of sections) {
    const lines = matrix.lines.filter((l) => l.band === band);
    if (lines.length === 0) continue;
    for (const l of lines) {
      numRow([label, l.accountCode, l.accountName, ...members.map((m) => l.amounts[m.key] ?? 0), l.total]);
    }
    bandRow(`Total ${label}`, pnlBand);
    if (band === 'costOfSales') bandRow('Gross Profit', 'grossProfit');
    if (band === 'operatingExpenses') bandRow('Operating Profit', 'operatingProfit');
  }
  bandRow('Net Profit / (Loss)', 'netProfit');

  ws.addRow([]);
  const tie = ws.addRow([
    isZeroResidual(matrix.residual) ? 'Ties to the Income Statement sheet' : 'DOES NOT TIE to the Income Statement sheet',
    '', 'Net profit residual (statement − columns)', matrix.residual.netProfit,
  ]);
  tie.getCell(4).numFmt = NUM_FMT;
  tie.font = { bold: true, color: { argb: isZeroResidual(matrix.residual) ? 'FF15803D' : 'FFDC2626' } };
  return ws;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end('Method Not Allowed');
    return;
  }

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const { period_start: start, period_end: end } = req.query as Record<string, string>;
  const ccId = req.query.cost_centre_id;
  const businessUnitId = req.query.business_unit_id;
  const groupBy = req.query.group_by;

  if (!start || !end) {
    res.status(400).json({ success: false, error: 'period_start and period_end are required' });
    return;
  }
  if (ccId !== undefined && !isUuidParam(ccId)) {
    return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
  }
  if (businessUnitId !== undefined && !isUuidParam(businessUnitId)) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }

  if (groupBy !== undefined && !isDimensionGroupBy(groupBy)) {
    return apiResponse.badRequest(res, 'group_by must be one of cc1, cc2, bu');
  }

  apiLogger.info({ companyId, start, end, groupBy }, 'Income statement xlsx export requested');

  const [companyRows, report] = await Promise.all([
    sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<Row[]>,
    getIncomeStatement(companyId, start, end, {
      costCentreId: ccId || undefined,
      businessUnitId,
    }),
  ]);

  const companyName = String(companyRows[0]?.name ?? 'Company');
  const today = new Date().toISOString().slice(0, 10);

  const wb = await buildIncomeStatementWorkbook(report, companyName, today);
  if (groupBy !== undefined) {
    addDimensionSheet(wb, await getIncomeStatementByDimension(companyId, start, end, groupBy, {
      costCentreId: ccId || undefined,
      businessUnitId,
    }));
  }

  const filename = `income-statement-${start}-to-${end}${groupBy ? `-by-${groupBy}` : ''}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
}

export default withAuth(withErrorHandler(handler));
