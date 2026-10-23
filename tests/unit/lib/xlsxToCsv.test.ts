/**
 * The external migration wizard advertised .xlsx but read the upload as UTF-8
 * text, so an Excel workbook parsed as binary garbage. xlsxBufferToCsv turns
 * the first worksheet into CSV text the existing parsers already read.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { xlsxBufferToCsv, looksLikeXlsx } from '@/lib/xlsxToCsv';

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Accounts');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('xlsxBufferToCsv', () => {
  it('converts the first sheet, quoting cells that need it', async () => {
    const buf = await workbook([
      ['Code', 'Name', 'Balance'],
      ['1000', 'Bank, Main', 1234.5],
      ['2000', 'He said "hi"', -10],
    ]);
    const csv = await xlsxBufferToCsv(buf);
    expect(csv.split('\n')).toEqual([
      'Code,Name,Balance',
      '1000,"Bank, Main",1234.5',
      '2000,"He said ""hi""",-10',
    ]);
  });

  it('writes date cells as ISO dates', async () => {
    const buf = await workbook([['Date'], [new Date(Date.UTC(2026, 3, 3))]]);
    const csv = await xlsxBufferToCsv(buf);
    expect(csv.split('\n')[1]).toBe('2026-04-03');
  });

  it('recognises an xlsx by its zip signature', async () => {
    expect(looksLikeXlsx(await workbook([['a']]))).toBe(true);
    expect(looksLikeXlsx(Buffer.from('Code,Name\n1,Bank\n'))).toBe(false);
  });
});
