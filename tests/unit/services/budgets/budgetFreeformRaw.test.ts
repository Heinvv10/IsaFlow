/**
 * The free-form budget sheet read from raw XML (MCP budget tools PR 2, review round 4: close the class, not the
 * case). Every money cell is accounted for (a row with an amount and no readable code refuses; only empty rows and
 * total rows are skipped); no hidden or merged layout (any hidden row or column, filter-hidden included, any merge in
 * any form, refuses the file); the parts are parsed by an XML parser, never scanned by regex (single quotes, long
 * tags, case); a money cell's number format must be General or a plain number / currency / accounting one; sheet
 * names are compared after NFKC, zero-width and space stripping and case folding; the sheet Excel opens on must be
 * the one read. Each test is one of the breaker's forms, written as raw XML.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { readImportWorkbook } from '@/modules/accounting/services/budgets/budgetImportFreeformRead';
import { freeformLines } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { MONTHS, model } from '../../mcp/budgetToolsFixture';
import { rawBook, rowXml, sheetBody, stylesWith, type RawBook, type RawCellSpec } from './rawXlsxFixture';

const HEAD = rowXml(1, ['Code', ...MONTHS]);
const book = (body: string, extra: Partial<RawBook> = {}) => rawBook({ sheets: [{ name: 'Budget', body }], activeTab: 0, ...extra });
async function freeform(buf: Buffer) {
  const r = await readImportWorkbook(buf);
  if (r.kind !== 'freeform') throw new Error('not read as free-form');
  return r.sheet;
}
const linesOf = async (buf: Buffer) => freeformLines(model(), 'company', await freeform(buf));
const row2 = (cells: RawCellSpec[], attrs = '') => rowXml(2, cells, attrs);

describe('rule 2: no hidden or merged layout anywhere on the sheet read', () => {
  it.each([
    ['a hidden row', sheetBody(HEAD + row2(['6000', 5], ' hidden="1"')), /hidden rows or columns \(row 2\)/],
    ['a row hidden by an AutoFilter', sheetBody(HEAD + row2(['6000', 5]) + rowXml(3, ['4000', 7], ' hidden="1"'), '<autoFilter ref="A1:M3"/>'), /hidden rows or columns \(row 3\)/],
    ['hidden=\'1\' single-quoted', sheetBody(HEAD + row2(['6000', 5], " hidden='1'")), /hidden rows or columns \(row 2\)/],
    ['hidden="true"', sheetBody(HEAD + row2(['6000', 5], ' hidden="true"')), /hidden rows or columns \(row 2\)/],
    ['a row of height 0', sheetBody(HEAD + row2(['6000', 5], ' ht="0" customHeight="1"')), /hidden rows or columns \(row 2\)/],
    ['a hidden column', sheetBody(HEAD + row2(['6000', 5]), '', '<cols><col min="3" max="3" width="9" hidden="1"/></cols>'), /hidden rows or columns \(column C\)/],
    ['a column of width 0', sheetBody(HEAD + row2(['6000', 5]), '', '<cols><col min="2" max="2" width="0" customWidth="1"/></cols>'), /hidden rows or columns \(column B\)/],
    ['every row hidden by default', sheetBody(HEAD + row2(['6000', 5]), '', '<sheetFormatPr defaultRowHeight="15" zeroHeight="1"/>'), /hidden rows or columns \(every row\)/],
  ])('%s refuses the file', async (_n, body, why) => {
    await expect(readImportWorkbook(await book(body))).rejects.toThrow(why);
  });

  it.each([
    ['a code merged down rows', 'A2:A3'], ['lower-case refs', 'b2:d2'], ['$-anchored refs', '$B$2:$D$2'],
  ])('a merge in any form refuses the file: %s', async (_n, ref) => {
    await expect(readImportWorkbook(await book(sheetBody(HEAD + row2(['6000', 5]) + rowXml(3, [null, 9]), `<mergeCells count='1'><mergeCell ref='${ref}'/></mergeCells>`))))
      .rejects.toThrow(new RegExp(`^Sheet "Budget" has merged cells \\(${ref.replace(/\$/g, '\\$')}\\)`));
  });
});

describe('rule 1: every money cell is accounted for', () => {
  it('a row with an amount and a blank code refuses (it is never skipped)', async () => {
    const out = await linesOf(await book(sheetBody(HEAD + row2(['', 5]))));
    expect(out.errors).toEqual([{ row: 2, column: 'Account code', account: '', message: 'Sheet "Budget", row 2, column A: this row has amounts but no account code.' }]);
  });

  it('an error code (#N/A from a failed VLOOKUP) refuses, with or without amounts', async () => {
    const na = { raw: '<c r="$REF" t="e"><v>#N/A</v></c>' };
    for (const cells of [[na, 5], [na]] as RawCellSpec[][]) {
      const out = await linesOf(await book(sheetBody(HEAD + row2(cells))));
      expect(out.errors[0]!.message).toBe('Sheet "Budget", row 2, column A: the account code is an error value (#N/A: a formula that failed), not a code.');
    }
  });

  it('only empty rows and total rows are skipped; an error in a month cell is refused per cell', async () => {
    const out = await linesOf(await book(sheetBody(HEAD + row2([null, null]) + rowXml(3, ['Total', 5]) + rowXml(4, ['6000', { raw: '<c r="$REF" t="e"><v>#DIV/0!</v></c>' }]))));
    expect(out.skipped).toEqual([{ row: 3, reason: 'a total row', amounts: { '2026-03': '5.00' } }]);
    expect(out.lines[0]!.amounts[0]!.cell).toEqual({ kind: 'error', raw: '', reason: 'This cell is an error value (#DIV/0!: a formula that failed), not an amount.' });
  });
});

describe('rule 3: parsed, not scanned (the forms the regexes missed)', () => {
  it.each([
    ['a TRUE single-quoted', { raw: "<c r='$REF' t='b'><v>1</v></c>" }],
    ['a TRUE in a tag over 1024 characters', { raw: `<c r="$REF" t="b" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xr:uid="${'a'.repeat(2000)}"><v>1</v></c>` }],
  ])('%s is refused per cell', async (_n, cell) => {
    const out = await linesOf(await book(sheetBody(HEAD + row2(['6000', cell as RawCellSpec]))));
    expect(out.lines[0]!.amounts[0]!.cell).toEqual({ kind: 'error', raw: '', reason: 'This cell is a TRUE / FALSE value, not an amount.' });
  });

  it('XML the parser cannot read refuses the file', async () => {
    await expect(readImportWorkbook(await book(sheetBody(HEAD).replace('</sheetData>', '<row r="2"><c r="A2"><v>1</v></row></sheetData>')))).rejects.toThrow(/./);
  });

  it.each([[" state='hidden'"], [' state="Hidden"'], [' state="VERYHIDDEN"']])('a sheet with%s is never read; the first visible one is', async (attrs) => {
    const buf = await rawBook({ activeTab: 1, sheets: [{ name: 'Old draft', attrs, body: sheetBody(HEAD + row2(['6000', 999])) }, { name: 'Budget', body: sheetBody(HEAD + row2(['6000', 250])) }] });
    const sheet = await freeform(buf);
    expect([sheet.name, freeformLines(model(), 'company', sheet).lines[0]!.amounts[0]!.cell]).toEqual(['Budget', { kind: 'value', cents: 25000 }]);
  });

  it('a sheet state the reader does not know refuses the file', async () => {
    const buf = await rawBook({ activeTab: 0, sheets: [{ name: 'Budget', attrs: ' state="secret"', body: sheetBody(HEAD) }] });
    await expect(readImportWorkbook(buf)).rejects.toThrow(/sheet "Budget" has a state \("secret"\) IsaFlow does not know/);
  });
});

describe('rule 5: sheet names compared after NFKC, zero-width and space stripping and case folding', () => {
  it.each([['_Meta'], [' _base'], ['_​meta'], ['_mеta'], ['＿meta'], ['_notes'], ['_&#109;eta']])('a sheet named %j refuses the file', async (name) => {
    const buf = await rawBook({ activeTab: 0, sheets: [{ name: 'Budget', body: sheetBody(HEAD + row2(['6000', 1])) }, { name, body: sheetBody('') }] });
    await expect(readImportWorkbook(buf)).rejects.toThrow(/_meta|_base|starts with "_"|IsaFlow budget template/);
  });
});

describe('rule 4: a money cell\'s number format must be General or a plain number / currency / accounting format', () => {
  const FORMATS: Array<[string, number, string | undefined, boolean]> = [
    ['General', 0, undefined, true], ['#,##0.00 (built-in 4)', 4, undefined, true], ['$ accounting (built-in 44; round 5)', 44, undefined, false],
    ['rand with a red negative, quoted (round 5: no literals)', 164, '"R" #,##0.00;[Red]-"R" #,##0.00', false], ['ZA accounting, with literals (round 5)', 165, '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-', false],
    ['[$R-1C09]', 166, '[$R-1C09]#,##0.00', true],
    ['bbbb (Buddhist year)', 167, 'bbbb', false], ['aaa (Japanese weekday)', 168, 'aaa', false], ['built-in 27 (CJK date)', 27, undefined, false],
    ['built-in 36', 36, undefined, false], ['built-in 50', 50, undefined, false], ['built-in 58', 58, undefined, false], ['built-in 14 (date)', 14, undefined, false],
    ['yyyy-mm', 169, 'yyyy-mm', false], ['[h]:mm', 170, '[h]:mm', false], ['0.00%', 171, '0.00%', false], ['0.00E+00', 172, '0.00E+00', false],
    ['@ (text)', 173, '@', false], ['[<1000]0', 174, '[<1000]0', false], ['# ?/?', 175, '# ?/?', false], ['[$-409] locale', 176, '[$-409]#,##0', false],
  ];
  it.each(FORMATS)('%s', async (_n, id, code, plain) => {
    const styles = stylesWith([0, id], code === undefined ? {} : { [id]: code });
    const out = await linesOf(await book(sheetBody(HEAD + row2(['6000', { n: 12.5, s: 1 }])), { styles }));
    expect(out.lines[0]!.amounts[0]!.cell).toEqual(plain ? { kind: 'value', cents: 1250 }
      : { kind: 'error', raw: '12.5', reason: expect.stringMatching(/^This cell's number format \(.+\) is not a plain number, currency or accounting format/) });
  });

  it('a header cell that is a date (a number formatted as one) names its month', async () => {
    const serial = (m: string) => (Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1) - Date.UTC(1899, 11, 30)) / 86_400_000;
    const head = rowXml(1, ['Code', ...MONTHS.map((m) => ({ n: serial(m), s: 1 }))]);
    const out = await linesOf(await book(sheetBody(head + row2(['6000', 3])), { styles: stylesWith([0, 14]) }));
    expect(out.lines[0]!.amounts.map((a) => a.month)).toEqual(MONTHS);
  });
});

describe('rule 6: the sheet read is the one Excel opens on', () => {
  it('a workbook that opens on another sheet than its first visible one is refused', async () => {
    const buf = await rawBook({ activeTab: 1, sheets: [{ name: 'Budget', body: sheetBody(HEAD) }, { name: 'Second', body: sheetBody(HEAD) }] });
    await expect(readImportWorkbook(buf)).rejects.toThrow(/^Excel opens this workbook on sheet "Second", not on "Budget", its first visible sheet/);
  });
});
