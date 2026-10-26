/**
 * Hostile workbooks (security review of M9). One parser (jszip) reads the
 * upload; ExcelJS only ever sees the normalised zip xlsxNormalise rebuilds
 * from those bytes. So:
 *   - a zip whose local entries disagree with its central directory shows
 *     ExcelJS what jszip counted, not the hidden entry;
 *   - the sheet's own row numbers are not trusted (non-increasing refused);
 *   - one long shared string repeated in every cell hits the output budget;
 *   - a sheet stored before its shared strings (or a workbook with none) is
 *     never deferred to a temp file.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import tmp from 'tmp';
import { SpreadsheetMalformedError, SpreadsheetTooLargeError, xlsxBufferToCsv } from '@/lib/xlsxToCsv';

const limits = { maxUncompressedBytes: 1024 * 1024, maxRows: 50, maxColumns: 10, maxOutputBytes: 8 * 1024 };

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const sheetXml = (rowsXml: string) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  + rowsXml + '</sheetData></worksheet>';

/** A workbook whose first sheet is replaced by `xml` (and optional shared strings). */
async function withSheet(xml: string, sharedStrings?: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await workbook([['placeholder']]));
  zip.file('xl/worksheets/sheet1.xml', xml);
  if (sharedStrings !== undefined) zip.file('xl/sharedStrings.xml', sharedStrings);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * `hidden`'s local entries prepended to `real`, with every central-directory
 * offset of `real` shifted past them: jszip (central directory) sees only
 * `real`; a reader that walks local headers from the front meets `hidden` first.
 */
function prependHiddenEntries(real: Buffer, hidden: Buffer): Buffer {
  const hiddenEocd = hidden.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const hiddenLocal = hidden.subarray(0, hidden.readUInt32LE(hiddenEocd + 16));
  const out = Buffer.concat([hiddenLocal, real]);
  const shift = hiddenLocal.length;
  const eocd = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdStart = out.readUInt32LE(eocd + 16) + shift;
  out.writeUInt32LE(cdStart, eocd + 16);
  const entries = out.readUInt16LE(eocd + 10);
  let at = cdStart;
  for (let i = 0; i < entries; i++) {
    expect(out.readUInt32LE(at)).toBe(0x02014b50);
    out.writeUInt32LE(out.readUInt32LE(at + 42) + shift, at + 42);
    at += 46 + out.readUInt16LE(at + 28) + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  return out;
}

describe('xlsxBufferToCsv on hostile workbooks', () => {
  it('reads the entry jszip counted, not a local entry the central directory hides', async () => {
    const real = await workbook([['GOOD']]);
    // The hidden zip carries its own workbook, rels and (empty) shared strings ahead of the sheet. ExcelJS's streaming
    // reader needs the workbook model before it can emit a sheet; with the sheet alone it reads the sheet first, and
    // about 1 run in 100 the stream ends before the real workbook.xml (stored last) arrives: "reading 'sheets'".
    const evil = new JSZip();
    const realZip = await JSZip.loadAsync(real);
    for (const path of ['xl/_rels/workbook.xml.rels', 'xl/workbook.xml']) evil.file(path, await realZip.file(path)!.async('string'));
    evil.file('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>');
    evil.file('xl/worksheets/sheet1.xml', sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>EVIL</t></is></c></row>'));
    const hidden = await evil.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const crafted = prependHiddenEntries(real, hidden);

    // The differential is real: ExcelJS reading the raw upload meets EVIL.
    const raw = new ExcelJS.stream.xlsx.WorkbookReader(
      (await import('node:stream')).Readable.from([crafted]),
      { worksheets: 'emit', sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore', entries: 'ignore' },
    );
    const seen: string[] = [];
    for await (const ws of raw) { for await (const row of ws) seen.push(String(row.getCell(1).value)); break; }
    expect(seen).toContain('EVIL');

    expect(await xlsxBufferToCsv(crafted, limits)).toBe('GOOD');
  });

  it('refuses rows whose numbers do not increase', async () => {
    const xml = sheetXml('<row r="5"><c r="A5"><v>1</v></c></row><row r="3"><c r="A3"><v>2</v></c></row>');
    const err = await xlsxBufferToCsv(await withSheet(xml), limits).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SpreadsheetMalformedError);
  });

  it('counts rows itself: sparse row numbers still count one each', async () => {
    const xml = sheetXml(Array.from({ length: 51 }, (_, i) => `<row r="${i * 1000 + 1}"><c r="A${i * 1000 + 1}"><v>${i}</v></c></row>`).join(''));
    await expect(xlsxBufferToCsv(await withSheet(xml), limits)).rejects.toBeInstanceOf(SpreadsheetTooLargeError);
  });

  it('stops one shared string repeated in every cell at the output budget', async () => {
    const long = 'x'.repeat(1000);
    const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${long}</t></si></sst>`;
    const cells = (r: number) => Array.from({ length: 10 }, (_, c) => `<c r="${String.fromCharCode(65 + c)}${r}" t="s"><v>0</v></c>`).join('');
    const xml = sheetXml(Array.from({ length: 5 }, (_, i) => `<row r="${i + 1}">${cells(i + 1)}</row>`).join(''));
    const buf = await withSheet(xml, sst);
    expect(buf.length).toBeLessThan(limits.maxOutputBytes); // small in, 50 KB out
    const err = await xlsxBufferToCsv(buf, limits).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SpreadsheetTooLargeError);
    expect((err as Error).message).toMatch(/MB of text/);
  });

  it('never defers the sheet to a temp file: sheet stored first, or no shared strings at all', async () => {
    const file = vi.spyOn(tmp, 'file');
    try {
      // Sheet entry BEFORE sharedStrings in the upload's own order.
      const src = await JSZip.loadAsync(await workbook([['Code', 'Name'], ['1000', 'Bank']]));
      const sheetFirst = new JSZip();
      sheetFirst.file('xl/worksheets/sheet1.xml', await src.file('xl/worksheets/sheet1.xml')!.async('nodebuffer'));
      for (const [path, entry] of Object.entries(src.files)) {
        if (path !== 'xl/worksheets/sheet1.xml' && !entry.dir) sheetFirst.file(path, await entry.async('nodebuffer'));
      }
      const reordered = await sheetFirst.generateAsync({ type: 'nodebuffer' });
      expect(await xlsxBufferToCsv(reordered, limits)).toBe('Code,Name\n1000,Bank');

      // Numbers only: Excel writes no sharedStrings.xml.
      const numbers = await JSZip.loadAsync(await withSheet(sheetXml('<row r="1"><c r="A1"><v>42</v></c></row>')));
      numbers.remove('xl/sharedStrings.xml');
      expect(await xlsxBufferToCsv(await numbers.generateAsync({ type: 'nodebuffer' }), limits)).toBe('42');

      expect(file).not.toHaveBeenCalled();
    } finally {
      file.mockRestore();
    }
  });
});
