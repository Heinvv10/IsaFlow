/**
 * Review round 8 on the free-form budget sheet (MCP budget tools PR 2), in raw XML the way Excel writes it:
 * conditional formatting in SpreadsheetML and in Excel 2010's x14 extension (inside <extLst>), the sqref forms,
 * fill characters (`*` only before a space), the escaped space `\ ` (a literal space), decimals counted after a literal
 * (`#,##0.00\ ?` shows 3), and IsaFlow's own rounding at 1e10 and over (defined by IsaFlow, not by a renderer).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { readImportWorkbook } from '@/modules/accounting/services/budgets/budgetImportFreeformRead';
import { freeformLines } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { shownCents } from '@/modules/accounting/services/budgets/budgetFreeformAmounts';
import { MONTHS, model } from '../../mcp/budgetToolsFixture';
import { rawBook, rowXml, sheetBody, stylesWith } from './rawXlsxFixture';

const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM = 'http://schemas.microsoft.com/office/excel/2006/main';
const TITLE = rowXml(1, ['Budget']);
const HEAD = rowXml(2, ['Code', ...MONTHS]);
const ROW = rowXml(3, ['6000', 1500]);
async function lines(after: string, dxfs = '<dxfs count="1"><dxf><font><color rgb="FFFFFFFF"/></font></dxf></dxfs>') {
  const buf = await rawBook({ sheets: [{ name: 'Budget', body: sheetBody(TITLE + HEAD + ROW, after) }], activeTab: 0, styles: stylesWith([0]) + dxfs });
  const r = await readImportWorkbook(buf);
  if (r.kind !== 'freeform') throw new Error('not free-form');
  return freeformLines(model(), 'company', r.sheet);
}
const cf = (sqref: string, rule = '<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>0</formula></cfRule>') => `<conditionalFormatting sqref="${sqref}">${rule}</conditionalFormatting>`;
const x14 = (sqref: string, dxf = '<x14:dxf><font><color rgb="FFFFFFFF"/></font></x14:dxf>') => `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="${X14}"><x14:conditionalFormattings>`
  + `<x14:conditionalFormatting xmlns:xm="${XM}"><x14:cfRule type="expression" priority="1" id="{00000000-0000-0000-0000-000000000001}"><xm:f>B3&gt;0</xm:f>${dxf}</x14:cfRule>`
  + `<xm:sqref>${sqref}</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst>`;
const REFUSED = /^Sheet "Budget" has conditional formatting \((.+)\) on or below its header row whose style sets a number format, font or fill/;

describe('1: conditional formatting', () => {
  it.each([
    ['on the body', cf('B3:M3')], ['two ranges, one on the body', cf('A1 B3:C3')], ['a whole column', cf('B:B')], ['$-anchored', cf('$B$3:$C$3')],
    ['reaching from the title down', cf('A1:B9')], ['on the header row', cf('B2')], ['a dxfId the styles do not have', cf('B3', '<cfRule type="cellIs" dxfId="7" priority="1" operator="equal"><formula>1</formula></cfRule>')],
    ['an x14 rule (inside extLst) on the body', x14('B3:M3')], ['an x14 rule with a number format', x14('C3', '<x14:dxf><numFmt numFmtId="200" formatCode="#,##0,"/></x14:dxf>')],
    ['an x14 rule with a fill', x14('C3', '<x14:dxf><fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill></x14:dxf>')],
    ['an x14 rule with no sqref', x14('').replace('<xm:sqref></xm:sqref>', '')],
  ])('%s refuses', async (_n, after) => {
    await expect(lines(after)).rejects.toThrow(REFUSED);
  });

  it.each([
    ['on the title row above the header', cf('A1:N1')], ['a rule with no style (a colour scale)', cf('B3:M3', '<cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FF63BE7B"/></colorScale></cfRule>')],
    ['a style that sets only a border', cf('B3:M3')], ['an x14 rule above the header', x14('A1:N1')], ['an x14 data bar (no style)', x14('B3:M3', '<x14:dataBar minLength="0" maxLength="100"><x14:cfvo type="autoMin"/><x14:cfvo type="autoMax"/></x14:dataBar>')],
  ])('%s is read', async (name, after) => {
    const dxfs = name.includes('border') ? '<dxfs count="1"><dxf><border><top style="thin"/></border></dxf></dxfs>' : undefined;
    expect((await lines(after, dxfs)).lines.map((l) => [l.row, l.amounts[0]!.cell])).toEqual([[3, { kind: 'value', cents: 150000 }]]);
  });
});

async function cellWith(code: string, value: number) {
  const buf = await rawBook({ sheets: [{ name: 'Budget', body: sheetBody(rowXml(1, ['Code', ...MONTHS]) + rowXml(2, ['6000', { n: value, s: 1 }])) }], activeTab: 0, styles: stylesWith([0, 164], { 164: code }) });
  const r = await readImportWorkbook(buf);
  if (r.kind !== 'freeform') throw new Error('not free-form');
  return freeformLines(model(), 'company', r.sheet).lines[0]!.amounts[0]!.cell;
}
const NOT_PLAIN = { kind: 'error', reason: expect.stringMatching(/^This cell's number format/) };

describe('2, 3: fill characters and the escaped space', () => {
  it.each([['#,##0.00*0'], ['*-#,##0.00'], ['*9#,##0.00'], ['#,##0.00;*-#,##0.00']])('a fill character other than a space refuses: %s', async (code) => {
    expect(await cellWith(code, 12.5)).toMatchObject(NOT_PLAIN);
  });
  it.each([['* #,##0.00'], ['#,##0.00\\ '], ['#,##0.00_ ;[RED]\\-#,##0.00\\ '], ['[$-409]#,##0.00\\ ']])('%s is read (a space fill, a literal space)', async (code) => {
    expect(await cellWith(code, -12.5)).toEqual({ kind: 'value', cents: -1250 });
  });
  it('#,##0.00\\ ? shows 3 decimals (LibreOffice draws 1.234 as "1.23 4"): a value with 3 is refused, not rounded', async () => {
    expect(await cellWith('#,##0.00\\ ?', 1.23)).toEqual({ kind: 'value', cents: 123 });
    expect(await cellWith('#,##0.00\\ ?', 1.234)).toEqual({ kind: 'error', raw: '1.234', reason: 'has more than 2 decimals; round it to cents in the sheet (a free-form sheet is not rounded for you)' });
  });
});

describe('4: the rounding is IsaFlow\'s own, also at 1e10 and over', () => {
  it.each([[12345678901.125, 1234567890113], [123456789012.345, 12345678901235], [-98765432109.875, -9876543210988]])('%s rounds to %s cents (15 significant digits, half away from zero)', (value, cents) => {
    expect(shownCents(value)).toBe(cents);
  });
});
