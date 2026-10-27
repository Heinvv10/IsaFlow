/**
 * Budgets P2 PR-B round 3, N1 (breaker r3): the XML scan behind normaliseXlsx /
 * normaliseXlsxSheets / xlsxBufferToCsv keeps a stack of element NAMES, so a close tag must name
 * the element it closes: `<x></>` x 3.2M (18 MB) passed the depth-only scan and cost 19.8 s and
 * 1.5 GB in the parser. It also refuses a duplicate attribute name and more than MAX_XML_ATTRIBUTES
 * attributes on one element (3M duplicate attributes cost 10 s: saxes builds an Error for each and
 * keeps going), and a part that ends with elements still open. Behind the scan, ExcelJS is fed the
 * normalised zip in bounded chunks, so a parser error stops the read within one chunk instead of
 * after the whole part: a part the scan accepts but the parser refuses everywhere (an undefined
 * entity in every cell) is a fast 400 too, on the CSV and budget readers alike.
 * L4: each branch of the scan that skips text (comment, CDATA, processing instruction, a quoted
 * attribute value holding `>` or a tag) is tested directly, and a workbook re-saved by LibreOffice
 * passes the scan part by part and converts (generated here: the self-hosted runner has soffice).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normaliseXlsx, normaliseXlsxSheets } from '@/lib/xlsxNormalise';
import { checkXmlPart } from '@/lib/xlsxXmlScan';
import { SpreadsheetMalformedError, xlsxBufferToCsv } from '@/lib/xlsxToCsv';
import { readBudgetWorkbook } from '@/modules/accounting/services/budgets/budgetImportParse';

const MB = 1024 * 1024;
/**
 * The time bounds are asserted by hand only (`XLSX_TIMING_BOUNDS=1 bunx vitest run <file>`): on a
 * loaded CI machine a wall-clock bound measures the machine. Correctness is asserted always.
 */
const TIMED = process.env.XLSX_TIMING_BOUNDS === '1';
const FAST_MS = 3000;
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const sheet = (rows: string) => `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;

async function withSheet(xml: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Budget').addRow(['a', 1]);
  wb.addWorksheet('_meta', { state: 'hidden' }).addRow(['versionId', 'x']);
  wb.addWorksheet('_base', { state: 'hidden' }).addRow(['Account code']);
  const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
  zip.file('xl/worksheets/sheet1.xml', xml);
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
const paths = (buf: Buffer) => [
  () => normaliseXlsx(buf, 80 * MB),
  () => normaliseXlsxSheets(buf, ['Budget', '_meta'], { maxBytes: 80 * MB }),
  () => xlsxBufferToCsv(buf),
];

describe('N1: the scan matches close tags to open ones by name', () => {
  it.each([
    ['breaker r3: <x></> x 3.2M', sheet(`<row r="1">${'<x></>'.repeat(3_200_000)}</row>`)],
    ['<a></> x 3.2M, then valid rows', sheet(`<row r="1">${'<a></>'.repeat(3_200_000)}</row><row r="2"><c r="A2"><v>1</v></c></row>`)],
    ['a mismatched close tag', sheet('<row r="1"><c r="A1"><v>1</v></row></c>')],
    ['a part that ends with elements open', `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1">`],
    ['breaker r3: one tag with 3M duplicate attributes', sheet(`<row r="1"><c r="A1" ${'a="1" '.repeat(3_000_000)}><v>1</v></c></row>`)],
    ['one tag with 200 distinct attributes', sheet(`<row r="1"><c r="A1" ${Array.from({ length: 200 }, (_, i) => `a${i}="1"`).join(' ')}><v>1</v></c></row>`)],
  ])('%s is refused fast, on every path', async (_label, xml) => {
    const buf = await withSheet(xml);
    for (const run of paths(buf)) {
      const { ms, err } = await refusal(run);
      expect(err).toBeInstanceOf(SpreadsheetMalformedError);
      if (TIMED) expect(ms).toBeLessThan(FAST_MS);
    }
  }, 180000);

  it('well-formed XML passes: prefixes, whitespace before >, quoted > and \', self-closing, comments, CDATA', () => {
    const ok = `<?xml version="1.0"?><!-- c --><x:w xmlns:x="u" a = "1>2" b='q"'><x:r ><x:c/><x:c t="s"><![CDATA[<not a tag>]]></x:c></x:r ><e/></x:w>`;
    expect(() => checkXmlPart(Buffer.from(ok))).not.toThrow();
  });
});

describe('N1: the parser stops at its first error', () => {
  // `&q;` is an undefined entity: the scan does not read entities, saxes refuses each one.
  const entities = (n: number) => sheet(`<row r="1">${'<c r="A1" t="str"><v>&q;</v></c>'.repeat(n)}</row>`);

  // The stop-at-first-error bound is a time bound (the rest of the zip still streams past, unparsed),
  // so it is asserted by hand (TIMED); in CI these assert the refusal only.
  it('the CSV reader: 2M undefined entities (~64 MB) is a fast 400', async () => {
    const buf = await withSheet(entities(2_000_000));
    const { ms, err } = await refusal(() => xlsxBufferToCsv(buf));
    expect(err).toBeInstanceOf(SpreadsheetMalformedError);
    if (TIMED) expect(ms).toBeLessThan(FAST_MS * 3); // building the 64 MB fixture is in here
  }, 180000);

  it('the budget reader: 600k undefined entities (~19 MB) is a fast 400', async () => {
    const buf = await withSheet(entities(600_000));
    const { ms, err } = await refusal(() => readBudgetWorkbook(buf));
    expect(err).toBeInstanceOf(SpreadsheetMalformedError);
    if (TIMED) expect(ms).toBeLessThan(1500);
  }, 180000);
});

describe('L4: the scan\'s skipping branches, one by one', () => {
  const scan = (xml: string) => () => checkXmlPart(Buffer.from(xml));
  it.each([
    ['a comment holding tags', '<w><!-- </w> <x> --></w>'],
    ['a comment holding > and --', '<w><!-- a > b -- c --></w>'],
    ['CDATA holding tags', '<w><![CDATA[</w><x a="1" a="2">]]></w>'],
    ['a processing instruction holding > and a close tag', '<?xml version="1.0"?><?pi a > </w> ?><w/>'],
    ['a double-quoted attribute holding > and a tag', '<w a="1 > </w> <x>"></w>'],
    ['a single-quoted attribute holding > and "', `<w a='x > "y"'/>`],
    ['spaces around = and before the close', '<w a = "1"  b="2" ></w >'],
  ])('passes %s', (_label, xml) => { expect(scan(xml)).not.toThrow(); });

  it.each([
    ['an unterminated comment', '<w><!-- open'],
    ['an unterminated CDATA', '<w><![CDATA[ open'],
    ['an unterminated processing instruction', '<?pi open'],
    ['an unterminated attribute value', '<w a="open>'],
    ['an attribute with no value', '<w a></w>'],
    ['a DOCTYPE', '<!DOCTYPE w><w/>'],
  ])('refuses %s', (_label, xml) => { expect(scan(xml)).toThrow(SpreadsheetMalformedError); });
});

const SOFFICE = ['/usr/bin/soffice', '/usr/bin/libreoffice'].find((p) => fs.existsSync(p));
// ci-integration-skip: needs LibreOffice (soffice); the self-hosted runner has it, a machine without it skips.
describe.skipIf(!SOFFICE)('L4: a workbook re-saved by LibreOffice', () => {
  it('passes the scan part by part, and converts', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['Code', 'Name', 'Amount', 'Date']);
    for (let i = 0; i < 50; i++) ws.addRow([`C${i}`, i % 2 ? '=not a formula' : `Name & <${i}>`, i * 1.5, new Date(Date.UTC(2026, 2, 1 + i))]);
    ws.getRow(2).getCell(5).value = { formula: 'C2*2', result: 0 };
    ws.getColumn(3).numFmt = '#,##0.00';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-lo-'));
    try {
      fs.mkdirSync(path.join(dir, 'in'));
      fs.writeFileSync(path.join(dir, 'in', 'book.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));
      execFileSync(SOFFICE!, [`-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--headless', '--convert-to', 'xlsx', '--outdir', path.join(dir, 'out'), path.join(dir, 'in', 'book.xlsx')], { timeout: 180000, stdio: 'ignore' });
      const resaved = fs.readFileSync(path.join(dir, 'out', 'book.xlsx'));
      const zip = await JSZip.loadAsync(resaved);
      expect(await zip.file('docProps/app.xml')!.async('string')).toMatch(/LibreOffice/);
      const parts = Object.keys(zip.files).filter((p) => p.endsWith('.xml') || p.endsWith('.rels'));
      expect(parts.length).toBeGreaterThan(5);
      for (const p of parts) checkXmlPart(await zip.file(p)!.async('nodebuffer'));
      const csv = (await xlsxBufferToCsv(resaved)).split('\n');
      expect(csv[0]).toBe('Code,Name,Amount,Date,'); // padded to the formula's column
      expect(csv).toHaveLength(51);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);
});
