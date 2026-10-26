/**
 * The income statement's by-dimension matrix as an xlsx sheet — the "By CC1 /
 * CC2 / BU" sheet the income-statement-xlsx route adds beside the statement.
 */

import type ExcelJS from 'exceljs';
import type { IncomeStatementByDimension } from './incomeStatementByDimension';
import { isZeroResidual, type PnlBand } from './dimensionPnlColumns';

const TEAL_ARGB = 'FF0F766E';
const WHITE_ARGB = 'FFFFFFFF';
const NUM_FMT = '#,##0.00';

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
