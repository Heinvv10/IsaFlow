/** Names and numbers come from outside the company (a supplier's own invoice number): a leading = must stay text. */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildDueByDateSide, netPosition } from '@/modules/accounting/utils/dueByDate';
import { buildDueByDateWorkbook } from '@/modules/accounting/services/reports/dueByDateXlsx';
import type { OpenAgingInvoice } from '@/modules/accounting/utils/aging';

const row = (over: Partial<OpenAgingInvoice>): OpenAgingInvoice => ({
  id: 'i', invoiceNumber: 'INV-1', entityId: 'e', entityName: 'E', dueDate: '2026-11-10', dueDateMissing: false,
  totalAmount: 100, amountPaid: 0, balance: 100, invoiceDate: '2026-10-01', reference: null, ...over,
});

async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as ArrayBuffer);
  return back;
}

function report() {
  const ap = buildDueByDateSide('ap', [
    row({ entityId: 's', entityName: '=1+1', invoiceNumber: '@SUM(A1)', balance: 40 }),
    row({ id: 'u', entityId: 's', entityName: '=1+1', invoiceNumber: '+cmd|calc', dueDateMissing: true, balance: 5 }),
  ], '2026-11-05', '2026-11-30');
  const ar = buildDueByDateSide('ar', [row({ entityName: '-2+3', invoiceNumber: '=HYPERLINK("http://x")', balance: 100 })], '2026-11-05', '2026-11-30');
  return { today: '2026-11-05', byDate: '2026-11-30', ap, ar, netPosition: netPosition(ar.totals, ap.totals) };
}

function cells(ws: ExcelJS.Worksheet): ExcelJS.Cell[] {
  const out: ExcelJS.Cell[] = [];
  ws.eachRow((r) => r.eachCell((c) => out.push(c)));
  return out;
}

describe('Due by date workbook', () => {
  it('stores a name or invoice number starting with = as a text cell, never a formula', async () => {
    const wb = await roundTrip(buildDueByDateWorkbook(report()));
    for (const ws of wb.worksheets) {
      for (const c of cells(ws)) {
        expect(c.type, `${ws.name}!${c.address}`).not.toBe(ExcelJS.ValueType.Formula);
        expect(c.formula, `${ws.name}!${c.address}`).toBeUndefined();
      }
    }
    const supplier = cells(wb.getWorksheet('Due by date')!).find((c) => c.value === '=1+1')!;
    expect(supplier.type).toBe(ExcelJS.ValueType.String);
    const inv = cells(wb.getWorksheet('AR invoices')!).find((c) => c.value === '=HYPERLINK("http://x")')!;
    expect(inv.type).toBe(ExcelJS.ValueType.String);
    expect(cells(wb.getWorksheet('AP invoices')!).some((c) => c.value === '@SUM(A1)')).toBe(true);
  });

  it('states what the net position leaves out (documents with no due date)', async () => {
    const wb = await roundTrip(buildDueByDateWorkbook(report()));
    const texts = cells(wb.getWorksheet('Due by date')!).map((c) => String(c.value));
    expect(texts.map((t) => t.replace(/\s/g, ' '))).toContain('Excludes R 5.00 payables and R 0.00 receivables with no due date.');
  });
});
