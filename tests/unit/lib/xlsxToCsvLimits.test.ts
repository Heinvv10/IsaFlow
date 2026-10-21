/**
 * An .xlsx is a zip, and a 10 MB upload can inflate to gigabytes. The workbook
 * is measured by what it actually inflates to BEFORE ExcelJS loads it, and the
 * first sheet's rows and columns are capped, each refused with a sentence the
 * client can act on (SpreadsheetTooLargeError) rather than a crash or a hang.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { SpreadsheetTooLargeError, xlsxBufferToCsv } from '@/lib/xlsxToCsv';

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const limits = { maxUncompressedBytes: 1024 * 1024, maxRows: 5, maxColumns: 3, maxOutputBytes: 64 * 1024 };

describe('xlsxBufferToCsv limits', () => {
  it('refuses a workbook that inflates past the cap before ExcelJS reads it', async () => {
    // A real workbook whose sheet is 4 MB of whitespace: it deflates to a few
    // KB, and only the inflated-bytes count can be what refuses it.
    const zip = await JSZip.loadAsync(await workbook([['a']]));
    zip.file('xl/worksheets/sheet1.xml', ' '.repeat(4 * 1024 * 1024));
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(bomb.length).toBeLessThan(64 * 1024);
    const err = await xlsxBufferToCsv(bomb, limits).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SpreadsheetTooLargeError);
    expect((err as Error).message).toMatch(/too large/i);
  });

  it('refuses a sheet with more rows than the cap', async () => {
    const buf = await workbook(Array.from({ length: 6 }, (_, i) => [`r${i}`]));
    await expect(xlsxBufferToCsv(buf, limits)).rejects.toThrow(/rows/i);
  });

  it('refuses a sheet with more columns than the cap', async () => {
    const buf = await workbook([['a', 'b', 'c', 'd']]);
    await expect(xlsxBufferToCsv(buf, limits)).rejects.toBeInstanceOf(SpreadsheetTooLargeError);
  });

  // The caps must bound memory, not just the answer: the sheet is streamed and
  // the read stops at the first row past the cap. A full load
  // (Workbook.xlsx.load) builds the whole model first and only then could count
  // it — so it would know the sheet's full 2,000 rows; the streamed read
  // cannot, and never touches the full-model loader.
  it('stops reading at the first row past the cap, without loading the whole workbook', async () => {
    const buf = await workbook(Array.from({ length: 2000 }, (_, i) => [`r${i}`]));
    const fullLoad = vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get');
    try {
      const err = await xlsxBufferToCsv(buf, limits).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SpreadsheetTooLargeError);
      expect((err as Error).message).not.toContain('2000');
      expect(fullLoad).not.toHaveBeenCalled();
    } finally {
      fullLoad.mockRestore();
    }
  });

  it('converts a sheet exactly at the caps', async () => {
    const buf = await workbook(Array.from({ length: 5 }, (_, i) => [`r${i}`, 1, 2]));
    expect((await xlsxBufferToCsv(buf, limits)).split('\n')).toHaveLength(5);
  });

  it('has sane defaults: an ordinary workbook converts without limits passed', async () => {
    const buf = await workbook([['Code', 'Name'], ['1000', 'Bank']]);
    expect(await xlsxBufferToCsv(buf)).toBe('Code,Name\n1000,Bank');
  });
});
