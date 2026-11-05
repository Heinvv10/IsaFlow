/**
 * Excel workbook for the "Due by date" report: one summary sheet (both sides,
 * net position) and one invoice sheet per side. Built from the report object
 * the JSON route returns, so the file and the page show the same figures.
 */

import ExcelJS from 'exceljs';
import type { DueByDateReport, DueByDateSide } from '../../utils/dueByDate';

const NUM_FMT = '#,##0.00';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
const FLAG_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };

const BUCKET_LABEL = {
  overdueNow: 'Overdue now',
  dueTodayToDate: 'Due today to date',
  dueLater: 'Due later',
  noDueDate: 'No due date',
} as const;

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
  });
}

function money(row: ExcelJS.Row, from: number, to: number): void {
  for (let c = from; c <= to; c++) row.getCell(c).numFmt = NUM_FMT;
}

function addSummary(ws: ExcelJS.Worksheet, label: string, entity: string, s: DueByDateSide): void {
  ws.addRow([`${label} (${entity})`]).font = { bold: true, size: 12 };
  styleHeader(ws.addRow([entity, 'Overdue now', 'Due today to date', 'Total by date', 'Due later', 'No due date', 'Disputed (held out)']));
  for (const c of s.contacts) {
    const row = ws.addRow([c.contactName, c.overdueNow, c.dueTodayToDate, c.totalByDate, c.dueLater, c.noDueDate, c.disputed]);
    money(row, 2, 7);
    if (c.noDueDate > 0) row.getCell(6).fill = FLAG_FILL;
  }
  const t = s.totals;
  const total = ws.addRow(['Total', t.overdueNow, t.dueTodayToDate, t.totalByDate, t.dueLater, t.noDueDate, t.disputed]);
  total.font = { bold: true };
  money(total, 2, 7);
  ws.addRow([]);
}

function addInvoices(wb: ExcelJS.Workbook, name: string, entity: string, s: DueByDateSide): void {
  const ws = wb.addWorksheet(name);
  ws.columns = [{ width: 32 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 20 }];
  styleHeader(ws.addRow([entity, 'Invoice #', 'Invoice date', 'Due date', 'Balance', 'Disputed', 'Counted', 'Bucket']));
  for (const c of s.contacts) {
    for (const i of c.invoices) {
      const row = ws.addRow([c.contactName, i.invoiceNumber, i.invoiceDate, i.dueDate ?? 'No due date', i.balance, i.disputed, i.counted, BUCKET_LABEL[i.bucket]]);
      money(row, 5, 7);
      if (i.dueDate === null) row.getCell(4).fill = FLAG_FILL;
    }
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

export function buildDueByDateWorkbook(report: DueByDateReport): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ISAFlow';
  wb.created = new Date();

  const ws = wb.addWorksheet('Due by date');
  ws.columns = [{ width: 36 }, { width: 16 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 20 }];
  ws.addRow(['Due by date']).font = { bold: true, size: 14 };
  ws.addRow([`Open documents at ${report.today}; due up to and including ${report.byDate}`]);
  ws.addRow(['Balances are current. No due date = the document records none, so it cannot be placed in time.']);
  ws.addRow([]);
  addSummary(ws, 'Receivables', 'Customer', report.ar);
  addSummary(ws, 'Payables', 'Supplier', report.ap);
  const net = ws.addRow(['Net position by date (receivables less payables, total by date)', report.netPosition]);
  net.font = { bold: true };
  money(net, 2, 2);

  addInvoices(wb, 'AR invoices', 'Customer', report.ar);
  addInvoices(wb, 'AP invoices', 'Supplier', report.ap);
  return wb;
}
