/**
 * What a hostile part costs the XML parser behind normaliseXlsx / normaliseXlsxSheets (budgets P2
 * PR-B round 2), for the budget import and the migration importer (xlsxBufferToCsv) alike:
 *   - BRK2-N1: element nesting past a small depth (unclosed or closed) is refused by a linear scan
 *     of each part before ExcelJS sees it: breaker r2's 3M-deep sheet took 10-33 s and up to 3 GB;
 *   - BRK2-N4 / SEC2-L3: a DOCTYPE is refused by the scan; anything ExcelJS itself trips on (a `<c>`
 *     with no `r`) is SpreadsheetMalformedError with a neutral message, never the parser's text;
 *   - BRK2-N6: styles.xml has its own cap, and rich-text runs count against the shared-string cap;
 *   - SEC2-L1 / VER-L1: only workbook.xml's <sheets> list is capped, so 1 MB of definedNames still
 *     converts.
 *   - Round 3 M1: the migration importer (xlsxBufferToCsv) caps styles and shared strings too
 *     (XLSX_LIMITS), sized so a generous real-shaped export (50 000 rows x 14 columns of mostly
 *     unique text: 13.5 MB / 409 000 shared strings) still converts.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { log } from '@/lib/logger';
import { normaliseXlsx, normaliseXlsxSheets } from '@/lib/xlsxNormalise';
import { SpreadsheetMalformedError, SpreadsheetTooLargeError, xlsxBufferToCsv } from '@/lib/xlsxToCsv';

const MB = 1024 * 1024;
/**
 * The time bounds are asserted by hand only (`XLSX_TIMING_BOUNDS=1 bunx vitest run <file>`): on a
 * loaded CI machine a wall-clock bound measures the machine. Correctness is asserted always.
 */
const TIMED = process.env.XLSX_TIMING_BOUNDS === '1';
const FAST_MS = 3000;
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const sheet = (rows: string) => `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Budget').addRow(['a', 1]);
  wb.addWorksheet('_meta', { state: 'hidden' }).addRow(['versionId', 'x']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function withParts(parts: Record<string, string>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await workbook());
  for (const [p, xml] of Object.entries(parts)) zip.file(p, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}
async function refusal(fn: () => Promise<unknown>): Promise<{ ms: number; err: unknown }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t0, err: null };
  } catch (err) {
    return { ms: Date.now() - t0, err };
  }
}
const named = (buf: Buffer, opts: Partial<Parameters<typeof normaliseXlsxSheets>[2]> = {}) => normaliseXlsxSheets(buf, ['Budget', '_meta'], { maxBytes: 80 * MB, ...opts });

describe('BRK2-N1: deep nesting is refused before the parser', () => {
  it.each([
    ['3M unclosed', sheet(`<row r="1">${'<x>'.repeat(3_000_000)}`)],
    ['2M closed', sheet(`<row r="1">${'<x>'.repeat(2_000_000)}${'</x>'.repeat(2_000_000)}</row>`)],
    ['40 deep', sheet(`<row r="1">${'<x>'.repeat(40)}${'</x>'.repeat(40)}</row>`)],
  ])('%s, on every path', async (_label, xml) => {
    const buf = await withParts({ 'xl/worksheets/sheet1.xml': xml });
    for (const run of [() => normaliseXlsx(buf, 80 * MB), () => named(buf), () => xlsxBufferToCsv(buf)]) {
      const { ms, err } = await refusal(run);
      expect(err).toBeInstanceOf(SpreadsheetMalformedError);
      if (TIMED) expect(ms).toBeLessThan(FAST_MS);
    }
  }, 120000);

  it('a real workbook (styles, shared strings, a formula, an inline rich string) passes the scan', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Budget');
    ws.addRow(['text', 1.5, { formula: 'B1*2', result: 3 }, { richText: [{ text: 'a', font: { bold: true } }, { text: 'b' }] }]);
    ws.getColumn(2).numFmt = '#,##0.00';
    const csv = await xlsxBufferToCsv(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(csv.split('\n')[0]).toBe('text,1.5,3,ab');
  });

  it('a nested part elsewhere (shared strings, styles) is refused too', async () => {
    const deep = `${'<x>'.repeat(100)}${'</x>'.repeat(100)}`;
    for (const part of ['xl/sharedStrings.xml', 'xl/styles.xml']) {
      const buf = await withParts({ [part]: `<?xml version="1.0"?><root ${NS}>${deep}</root>` });
      await expect(named(buf)).rejects.toBeInstanceOf(SpreadsheetMalformedError);
    }
  });
});

describe('BRK2-N4 / SEC2-L3: parser refusals are 400s with a neutral message', () => {
  it('a DOCTYPE (entity expansion) in any part', async () => {
    const lol = '<!DOCTYPE l [<!ENTITY a "aaaa">]>';
    const buf = await withParts({ 'xl/sharedStrings.xml': `<?xml version="1.0"?>${lol}<sst ${NS}><si><t>&a;</t></si></sst>` });
    for (const run of [() => named(buf), () => xlsxBufferToCsv(buf)]) {
      const { err } = await refusal(run);
      expect(err).toBeInstanceOf(SpreadsheetMalformedError);
      expect((err as Error).message).not.toMatch(/entity|1:\d+/);
    }
  });

  it('a <c> with no r attribute (ExcelJS throws a TypeError on it)', async () => {
    const buf = await withParts({ 'xl/worksheets/sheet1.xml': sheet(`<row r="1">${'<c><v>1</v></c>'.repeat(50)}</row>`) });
    const { err } = await refusal(() => xlsxBufferToCsv(buf));
    expect(err).toBeInstanceOf(SpreadsheetMalformedError);
    expect((err as Error).message).not.toMatch(/undefined|length|properties/);
  });
});

describe('BRK2-N6: styles and rich-text runs are capped', () => {
  it('styles.xml past maxStylesBytes is refused fast', async () => {
    const font = '<font><b/><sz val="11"/><name val="Calibri"/></font>';
    const buf = await withParts({ 'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><fonts>${font.repeat(Math.floor((4 * MB) / font.length))}</fonts></styleSheet>` });
    await expect(named(buf)).resolves.toMatchObject({ sheets: ['Budget', '_meta'] });
    const { ms, err } = await refusal(() => named(buf, { maxStylesBytes: MB }));
    expect(err).toBeInstanceOf(SpreadsheetTooLargeError);
    if (TIMED) expect(ms).toBeLessThan(FAST_MS);
  });

  it('rich-text runs count against maxSharedStrings', async () => {
    const run = '<r><rPr><b/></rPr><t>a</t></r>';
    const buf = await withParts({ 'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS}><si>${run.repeat(5000)}</si></sst>` });
    await expect(named(buf, { maxSharedStrings: 5001 })).resolves.toMatchObject({ sheets: ['Budget', '_meta'] });
    await expect(named(buf, { maxSharedStrings: 5000 })).rejects.toBeInstanceOf(SpreadsheetTooLargeError);
  });
});

describe('SEC2-L1 / VER-L1: only the <sheets> list of workbook.xml is capped', () => {
  it('1 MB of definedNames still converts, by the first sheet and by name', async () => {
    const zip = await JSZip.loadAsync(await workbook());
    const xml = await zip.file('xl/workbook.xml')!.async('string');
    const names = Array.from({ length: 18000 }, (_, i) => `<definedName name="N${i}">Budget!$A$1:$B$${i + 1}</definedName>`).join('');
    zip.file('xl/workbook.xml', xml.replace('</sheets>', `</sheets><definedNames>${names}</definedNames>`));
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect((await zip.file('xl/workbook.xml')!.async('string')).length).toBeGreaterThan(MB);
    expect((await xlsxBufferToCsv(buf)).split('\n')[0]).toBe('a,1');
    expect((await named(buf)).sheets).toEqual(['Budget', '_meta']);
  });
});

describe('round 3 M1: the migration importer caps styles and shared strings', () => {
  it.each([
    ['breaker I5: 76 MB of shared-string filler', 'xl/sharedStrings.xml', () => `<?xml version="1.0"?><sst ${NS}>${'<si><t>x</t></si>'.repeat(Math.floor((76 * MB) / 17))}</sst>`],
    ['5M + 1 tiny shared strings under the byte cap (entries past maxRows x maxColumns)', 'xl/sharedStrings.xml', () => `<?xml version="1.0"?><sst ${NS}>${'<si/>'.repeat(5_000_001)}</sst>`],
    ['23 MB of <font> in styles.xml', 'xl/styles.xml', () => `<?xml version="1.0"?><styleSheet ${NS}><fonts>${'<font><b/><sz val="11"/></font>'.repeat(Math.floor((23 * MB) / 32))}</fonts></styleSheet>`],
  ])('%s is refused fast', async (_label, part, xml) => {
    const buf = await withParts({ [part]: xml() });
    const { ms, err } = await refusal(() => xlsxBufferToCsv(buf));
    expect(err).toBeInstanceOf(SpreadsheetTooLargeError);
    if (TIMED) expect(ms).toBeLessThan(FAST_MS);
  }, 120000);

  it('a generous real-shaped export (50 000 rows x 14 columns, mostly unique text) still converts', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.addRow(['Code', 'Name', 'Contact', 'Email', 'Phone', 'Address 1', 'Address 2', 'City', 'Postal', 'VAT number', 'Terms', 'Balance', 'Limit', 'Notes']);
    for (let i = 0; i < 49_999; i++) {
      ws.addRow([`CUS${i}`, `Customer ${i} (Pty) Ltd`, `Contact Person ${i}`, `accounts${i}@customer${i}.co.za`, `+27 11 ${100000 + i}`, `${i} Main Road`, `Unit ${i % 300}`,
        ['Johannesburg', 'Cape Town', 'Durban'][i % 3], String(1000 + (i % 9000)), `4${100000000 + i}`, '30 days', i * 13.37, 50000, `Imported from Sage, row ${i}`]);
    }
    const csv = await xlsxBufferToCsv(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(csv.split('\n')).toHaveLength(50_000);
  }, 300000);

  it('round 9: a wide export with more shared strings than the old 1M entry cap (1.2M, 26 MB) still converts', async () => {
    const sst = `<?xml version="1.0"?><sst ${NS}>${Array.from({ length: 1_200_000 }, (_, i) => `<si><t>v${i}</t></si>`).join('')}</sst>`;
    expect(sst.length).toBeLessThan(32 * MB);
    const buf = await withParts({ 'xl/sharedStrings.xml': sst });
    expect((await xlsxBufferToCsv(buf)).split('\n')[0]).toBe('v0,1'); // A1 points at shared string 0
  }, 120000);
});

describe('round 9: a parser failure is logged by class and position only', () => {
  it('no message text reaches the log', async () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      const buf = await withParts({ 'xl/worksheets/sheet1.xml': sheet(`<row r="1">${'<c><v>1</v></c>'.repeat(5)}</row>`) });
      await expect(xlsxBufferToCsv(buf)).rejects.toBeInstanceOf(SpreadsheetMalformedError);
      const entity = await withParts({ 'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="str"><v>&q;</v></c></row>') });
      await expect(xlsxBufferToCsv(entity)).rejects.toBeInstanceOf(SpreadsheetMalformedError);
      const logged = warn.mock.calls.filter(([m]) => /parser failed/.test(String(m))).map(([, data]) => data);
      expect(logged).toHaveLength(2);
      for (const data of logged) {
        expect(Object.keys(data as object).sort()).toEqual(['errorClass', 'position']);
        expect((data as { position: string | null }).position ?? '').toMatch(/^(\d+:\d+)?$/);
      }
      expect(logged.map((d) => (d as { position: string | null }).position)).toEqual([null, expect.stringMatching(/^\d+:\d+$/)]);
    } finally {
      warn.mockRestore();
    }
  });
});
