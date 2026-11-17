/**
 * The free-form budget sheet's reader, review round 5 (the final hardening; the threat model is in the evidence
 * doc): namespaces (only SpreadsheetML elements are read, and a foreign one where the reader looks refuses the file),
 * shared-string and value strictness, one <v> per cell, depth, formula results, text amounts against their format,
 * the tightened number-format allowlist, hidden-layout thresholds, the size refusal surfacing as itself, look-alike
 * names starting with a combining mark. Each case is raw XML, in the breaker's form where there was one.
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { SpreadsheetTooLargeError } from '@/lib/xlsxToCsv';
import { readImportWorkbook } from '@/modules/accounting/services/budgets/budgetImportFreeformRead';
import { freeformLines } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { BUDGET_IMPORT_LIMITS } from '@/modules/accounting/services/budgets/budgetImportParse';
import { MONTHS, model } from '../../mcp/budgetToolsFixture';
import { rawBook, rowXml, sheetBody, stylesWith, type RawBook, type RawCellSpec } from './rawXlsxFixture';

const HEAD = rowXml(1, ['Code', ...MONTHS]);
const SHEET = '<sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets>';
const book = (body: string, extra: Partial<RawBook> = {}) => rawBook({ sheets: [{ name: 'Budget', body }], activeTab: 0, ...extra });
const read = (buf: Buffer) => readImportWorkbook(buf);
async function lines(buf: Buffer) {
  const r = await read(buf);
  if (r.kind !== 'freeform') throw new Error('not free-form');
  return freeformLines(model(), 'company', r.sheet);
}
const firstAmount = async (cell: RawCellSpec, extra: Partial<RawBook> = {}) => (await lines(await book(sheetBody(HEAD + rowXml(2, ['6000', cell])), extra))).lines[0]!.amounts[0]!.cell;
const FOREIGN = /is not a SpreadsheetML element/;

describe('1, 4: only SpreadsheetML elements are read; a foreign one where the reader looks refuses the file', () => {
  it.each([
    ['a decoy sheet in another namespace', `<sheets><x:sheet xmlns:x="urn:ns2" name="Decoy" sheetId="9" r:id="rId1"/><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets>`],
    ['a decoy workbookView', `<bookViews><y:workbookView xmlns:y="urn:ns3" activeTab="0"/></bookViews>${SHEET}`],
    ['mc:AlternateContent in sheets', `<sheets><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x"><sheet name="Budget" sheetId="1" r:id="rId1"/></mc:Choice></mc:AlternateContent></sheets>`],
    ['a foreign root child holding a SpreadsheetML element', `<z:wrap xmlns:z="urn:z"><sheets/></z:wrap>${SHEET}`],
  ])('workbook: %s', async (_n, workbookBody) => {
    await expect(read(await book(sheetBody(HEAD), { workbookBody }))).rejects.toThrow(FOREIGN);
  });

  it.each([
    ['an ignorable cell in another namespace', rowXml(2, ['6000', { raw: '<n1:c xmlns:n1="urn:ns1" r="$REF"><n1:v>9</n1:v></n1:c>' }])],
    ['mc:AlternateContent in sheetData', `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x">${rowXml(2, ['6000', 9])}</mc:Choice></mc:AlternateContent>`],
    ['a foreign element named row closing the real row early (breaker)', `<row r="2"><c r="A2" t="inlineStr"><is><t>6000</t></is></c><q:row xmlns:q="urn:q"></q:row><c r="B2"><v>9</v></c></row>`],
  ])('sheet: %s', async (_n, rows) => {
    await expect(read(await book(sheetBody(HEAD + rows)))).rejects.toThrow(FOREIGN);
  });

  it('a SpreadsheetML element where it does not belong (a <c> nested in a cell) refuses the file', async () => {
    await expect(read(await book(sheetBody(HEAD + rowXml(2, ['6000', { raw: '<c r="$REF"><c r="C2"><v>1</v></c><v>5</v></c>' }]))))).rejects.toThrow(/is not where SpreadsheetML puts it/);
  });

  it('a part whose root is not SpreadsheetML refuses the file', async () => {
    const zip = await JSZip.loadAsync(await book(sheetBody(HEAD)));
    zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml')!.async('string')).replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="urn:other"'));
    await expect(read(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(FOREIGN);
  });

  it.each([
    ['a <row> in <sheets>', { workbookBody: '<sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><row/></sheets>' }, /<row> is not where SpreadsheetML puts it \(inside <sheets>\)/],
    ['a <c> in a shared string', { sst: ['5'] }, /<c> is not where SpreadsheetML puts it \(inside <si>\)/, (x: string) => x.replace('<si><t>5</t></si>', '<si><t>5</t><c/></si>'), 'xl/sharedStrings.xml'],
    ['a <font> in <cellXfs>', { styles: '<cellXfs count="1"><xf numFmtId="0"/><font/></cellXfs>' }, /<font> is not where SpreadsheetML puts it \(inside <cellXfs>\)/],
    ['a SpreadsheetML-prefixed attribute', { workbookBody: `<bookViews><workbookView xmlns:m="${'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}" m:activeTab="0"/></bookViews>${SHEET}` }, /is written in a way no spreadsheet program writes/],
  ])('%s refuses the file', async (_n, extra, why, edit?: (x: string) => string, part?: string) => {
    let buf = await book(sheetBody(HEAD + rowXml(2, ['6000', 5])), extra as Partial<RawBook>);
    if (edit && part) {
      const zip = await JSZip.loadAsync(buf);
      zip.file(part, edit(await zip.file(part)!.async('string')));
      buf = await zip.generateAsync({ type: 'nodebuffer' });
    }
    await expect(read(buf)).rejects.toThrow(why);
  });

  it('styles: a decoy xf in another namespace refuses the file', async () => {
    const styles = '<cellXfs count="2"><xf numFmtId="0"/><w:xf xmlns:w="urn:ns4" numFmtId="0"/><xf numFmtId="14"/></cellXfs>';
    await expect(read(await book(sheetBody(HEAD + rowXml(2, ['6000', { n: 5, s: 1 }])), { styles }))).rejects.toThrow(FOREIGN);
  });

  it('what Excel and LibreOffice write outside SpreadsheetML is read past: mc:AlternateContent at the workbook root, extLst content, foreign attributes', async () => {
    const workbookBody = '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="C:\\"/></mc:Choice></mc:AlternateContent>'
      + `<bookViews><workbookView activeTab="0"/></bookViews>${SHEET}<extLst><ext uri="{X}"><loext:extCalcPr xmlns:loext="http://schemas.libreoffice.org/" stringRefSyntax="CalcA1"/></ext></extLst>`;
    const rows = `<row r="2" xmlns:xr="urn:xr" xr:hidden="1"><c r="A2" t="inlineStr"><is><t>6000</t></is></c><c r="B2"><v>9</v></c></row>`;
    const out = await lines(await book(sheetBody(HEAD + rows), { workbookBody }));
    expect(out.lines[0]!.amounts[0]!.cell).toEqual({ kind: 'value', cents: 900 });
  });
});

describe('2, 3, 5: values read exactly', () => {
  it.each([['no <v>', '<c r="$REF" t="s"/>'], ['an empty <v>', '<c r="$REF" t="s"><v></v></c>'], ['a <v> with a space', '<c r="$REF" t="s"><v> 0</v></c>'], ['a hex <v>', '<c r="$REF" t="s"><v>0x0</v></c>']])(
    'a shared-string cell with %s refuses the file', async (_n, raw) => {
      await expect(read(await book(sheetBody(HEAD + rowXml(2, ['6000', { raw }])), { sst: ['5'] }))).rejects.toThrow(/shared text/);
    });

  it('two <v> in one cell refuse the file', async () => {
    await expect(read(await book(sheetBody(HEAD + rowXml(2, ['6000', { raw: '<c r="$REF"><v>1</v><v>9</v></c>' }]))))).rejects.toThrow(/more than one value/);
  });

  it.each(['0x10', '0b1', '0o7', 'Infinity', 'NaN', ' 5', '5 ', '.5', '5.', '1e', '--5', '1_000'])('the number %j refuses the cell', async (v) => {
    expect(await firstAmount({ raw: `<c r="$REF"><v>${v}</v></c>` })).toEqual({ kind: 'error', raw: '', reason: expect.stringMatching(/^This cell is ".*", which is not a number, not an amount\.$/) });
  });

  it.each([['-0.5', -50], ['1E+03', 100000], ['12', 1200]])('the number %j is read', async (v, cents) => {
    expect(await firstAmount({ raw: `<c r="$REF"><v>${v}</v></c>` })).toEqual({ kind: 'value', cents });
  });

  it('a t="str" formula with no cached value is refused, as a t="n" one is', async () => {
    expect(await firstAmount({ raw: '<c r="$REF" t="str"><f>A1</f></c>' })).toEqual({ kind: 'error', raw: '', reason: expect.stringMatching(/^This cell is a formula with no saved result/) });
  });
});

describe('6, 7: formats (text amounts too), the tightened allowlist', () => {
  it.each([['";;;" (hidden)', ';;;'], ['an empty text section', '0.00;-0.00;0.00;']])('a text amount formatted %s is refused', async (_n, code) => {
    expect(await firstAmount({ raw: '<c r="$REF" s="1" t="inlineStr"><is><t>12.50</t></is></c>' }, { styles: stylesWith([0, 164], { 164: code }) }))
      .toEqual({ kind: 'error', raw: '12.50', reason: expect.stringMatching(/^This cell's number format \(.+\) is not a plain number/) });
  });

  const CASES: Array<[string, number, string | undefined, boolean]> = [
    ['"$"#,##0.00', 164, '"$"#,##0.00', false], ['\\€#,##0.00', 165, '\\€#,##0.00', false], ['built-in 5 ($ currency)', 5, undefined, false],
    ['#,##0, (scaling comma)', 166, '#,##0,', false], [',"1"0', 167, ',"1"0', false], ['0;-0;"9000"', 168, '0;-0;"9000"', false],
    ['"R" #,##0.00 (a quoted R: allowlisted since, the Excel en-ZA currency)', 169, '"R" #,##0.00', true], ['[<1000]0;0.00 (a condition)', 170, '[<1000]0;0.00', false], ['0;0 (a negative shown unsigned)', 171, '0;0', false],
    ['built-in 42 ($ accounting)', 42, undefined, false], ['built-in 44 ($ accounting)', 44, undefined, false],
    ['built-in 43', 43, undefined, true], ['built-in 40', 40, undefined, true],
    ['R #,##0.00 (a bare R)', 172, 'R #,##0.00', true], ['[$R-1C09] #,##0.00;[Red]-[$R-1C09] #,##0.00', 173, '[$R-1C09] #,##0.00;[Red]-[$R-1C09] #,##0.00', true],
    ['R alone (no digit placeholder: the amount is not shown)', 176, 'R', false], ['#,##0.00;(#,##0.00)', 174, '#,##0.00;(#,##0.00)', true], ['_-* #,##0.00_-;-* #,##0.00_-', 175, '_-* #,##0.00_-;-* #,##0.00_-', true],
  ];
  it.each([['built-in 41 (accounting, no currency, no decimals)', 41], ['built-in 3 (#,##0)', 3]])('%s: accepted for whole rands, refused for 12.5 (it would show 13)', async (_n, id) => {
    const styles = stylesWith([0, id]);
    expect(await firstAmount({ n: 12, s: 1 }, { styles })).toEqual({ kind: 'value', cents: 1200 });
    expect(await firstAmount({ n: 12.5, s: 1 }, { styles })).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^This cell shows 0 decimal places but holds 12.5/) });
  });

  it.each(CASES)('%s', async (_n, id, code, plain) => {
    const cell = await firstAmount({ n: 12.5, s: 1 }, { styles: stylesWith([0, id], code === undefined ? {} : { [id]: code }) });
    expect(cell).toEqual(plain ? { kind: 'value', cents: 1250 } : { kind: 'error', raw: '12.5', reason: expect.stringMatching(/^This cell's number format/) });
  });

  it.each([['a built-in id redefined', stylesWith([0, 4], { 4: '#,##0.00' }), /redefines built-in number format 4/], ['a numFmt id twice', `<numFmts count="2"><numFmt numFmtId="164" formatCode="0"/><numFmt numFmtId="164" formatCode="0.00"/></numFmts><cellXfs count="1"><xf numFmtId="0"/></cellXfs>`, /defines number format 164 twice/]])(
    '%s refuses the file', async (_n, styles, why) => {
      await expect(read(await book(sheetBody(HEAD + rowXml(2, ['6000', 5])), { styles }))).rejects.toThrow(why);
    });
});

describe('8: hidden layout by threshold', () => {
  it.each([
    ['a column narrower than 0.5', '<cols><col min="2" max="2" width="0.4" customWidth="1"/></cols>', /column B/],
    ['a row lower than 1pt', '', /row 2/, ' ht="0.5" customHeight="1"'],
    ['defaultColWidth 0', '<sheetFormatPr defaultRowHeight="15" defaultColWidth="0"/>', /every column/],
    ['defaultRowHeight below 1pt', '<sheetFormatPr defaultRowHeight="0.5"/>', /every row/],
  ])('%s refuses the file', async (_n, before, why, rowAttrs = '') => {
    await expect(read(await book(sheetBody(HEAD + rowXml(2, ['6000', 5], rowAttrs), '', before)))).rejects.toThrow(why);
  });
});

describe('9, 13: the size refusal is itself; names starting with a combining mark', () => {
  it('a sheet past the row limit is refused by SpreadsheetTooLargeError with its own message', async () => {
    const err = await readImportWorkbook(await book(sheetBody(HEAD + rowXml(2, ['6000', 1]) + rowXml(3, ['4000', 1]))), { ...BUDGET_IMPORT_LIMITS, maxRows: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpreadsheetTooLargeError);
    expect((err as Error).message).toMatch(/has more than 2 rows/);
  });

  it('a sheet whose name starts with a combining mark (a look-alike) refuses the file', async () => {
    const buf = await rawBook({ activeTab: 0, sheets: [{ name: 'Budget', body: sheetBody(HEAD) }, { name: '\u0301meta', body: sheetBody('') }] });
    await expect(read(buf)).rejects.toThrow(/starts with "_" or a combining mark/);
  });
});
