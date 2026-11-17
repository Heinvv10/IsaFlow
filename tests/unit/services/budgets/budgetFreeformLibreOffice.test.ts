/**
 * Free-form budget sheets made in LibreOffice 24.2 the way a user makes them (MCP budget tools PR 2, review round 7).
 * Every file under tests/fixtures/budgets/freeform/ was made over UNO: text TYPED through the input line (the locale's
 * number and date recognition and autoformat: en-ZA reads "4000,10" as a number and "Mar-26" as 26 March 2026), formats
 * from the Format Cells dialog's own generator (decimals, thousands separator, negative in red, Language) or typed as
 * a custom code, formulas entered, merges, widths, heights and the open sheet set as the UI sets them, then saved as
 * xlsx. No XML was edited. What LibreOffice SHOWS for each cell (its CSV, "save cell contents as shown") is in the
 * evidence doc beside what the reader imports. The generator: docs/plans/budgets/P7-mcp-tools-pr2-evidence.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { readImportWorkbook } from '@/modules/accounting/services/budgets/budgetImportFreeformRead';
import { freeformLines } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { CC1, model } from '../../mcp/budgetToolsFixture';

const DIR = join(__dirname, '../../../fixtures/budgets/freeform');
const file = (name: string) => readFileSync(join(DIR, `${name}.xlsx`));
async function sheetOf(name: string) {
  const r = await readImportWorkbook(file(name));
  if (r.kind !== 'freeform') throw new Error('not free-form');
  return r.sheet;
}
const linesOf = async (name: string, m: GridReadModel = model(), grain: 'company' | 'cc1' = 'company') => freeformLines(m, grain, await sheetOf(name));
const cents = (out: Awaited<ReturnType<typeof linesOf>>, code: string) => out.lines.find((l) => l.accountCode === code)!.amounts.map((a) => (a.cell.kind === 'value' ? a.cell.cents : a.cell.kind));

describe('B1: a numeric code is read only when its format is General (or Text) and it is a whole number', () => {
  const TEXT = /format the code column as text/;
  it.each(['b1-codes-en-us', 'b1-codes-en-za'])('%s', async (name) => {
    const out = await linesOf(name);
    expect(out.errors.map((e) => [e.row, e.column, e.account])).toEqual([[2, 'Account code', '4000.1'], [3, 'Account code', '4000.1'], [4, 'Account code', '400'], [6, 'Account code', '4000.5'], [8, 'Account code', '4000']]);
    for (const e of out.errors) expect(e.message).toMatch(TEXT);
    expect(out.errors[0]!.message).toBe(`Sheet "Sheet1", row 2, column A: the account code is the number 4000.1 in the number format ${name.endsWith('us') ? '[$-409]' : '[$-1C09]'}0.00, so the code you see is not the code IsaFlow would read (it shows a number's digits as the format draws them); format the code column as text and type the codes.`);
    expect(out.errors[3]!.message).toBe('Sheet "Sheet1", row 6, column A: the account code is the number 4000.5, which has a fraction, so it is not a code; format the code column as text and type the codes.');
    // 6000 (General) and 7100 (a number formatted as Text afterwards) are read.
    expect(out.lines.map((l) => [l.row, l.accountCode])).toEqual([[5, '6000'], [7, '7100']]);
  });

  it('the dimension code too: 10 shown as 10,00 is refused; 10 in General or Text is read', async () => {
    const m = model({ dimensions: { cc1: [{ id: CC1, code: '10', name: 'Ten', isActive: true }], cc2: [], bu: [] } as never });
    const out = await linesOf('b1-dimension-en-za', m, 'cc1');
    expect(out.errors).toEqual([{ row: 2, column: 'Dimension code', account: '6000', message: 'Sheet "Sheet1", row 2, column B: the dimension code is the number 10 in the number format [$-1C09]0.00, so the code you see is not the code IsaFlow would read (it shows a number\'s digits as the format draws them); format the dimension column as text and type the codes.' }]);
    expect(out.lines.map((l) => [l.row, l.accountCode, l.dimensionCode])).toEqual([[3, '4000', '10'], [4, '7100', '10']]);
  });
});

describe('1, 2: a negative section signed with \\- or wrapped in \\( \\) (as LibreOffice writes them)', () => {
  it.each(['signs-en-us', 'signs-en-za'])('%s: -5 imports as -5, 5 as 5, in every spelling', async (name) => {
    const out = await linesOf(name);
    expect(out.errors).toEqual([]);
    expect(cents(out, '6000').slice(0, 7)).toEqual(Array(7).fill(-500));
    expect(cents(out, '4000').slice(0, 7)).toEqual(Array(7).fill(500));
  });
});

describe('3: a leading locale-only tag ([$-1C09], [$-809], [$-436], [$-407]) is dropped before every check', () => {
  it.each(['locale-tags-en-us', 'locale-tags-en-za'])('%s: 0.00, #,##0.00, red negative, General and @ under a Language all read 12.50', async (name) => {
    expect(cents(await linesOf(name), '6000').slice(0, 6)).toEqual(Array(6).fill(1250));
  });
});

describe('4: the rand without a thousands separator', () => {
  it('the dialog\'s currency formats with the separator off, and "R "0.00, [$R-1C09]\\ 0.00, "R"0.00, "R "0 typed', async () => {
    expect(cents(await linesOf('rand-nosep-en-za'), '6000').slice(0, 8)).toEqual([-123450, -123450, -123400, -123400, 123450, -123450, 123450, 123400]);
  });
});

describe('5: a format showing 2 decimals rounds the value to cents by IsaFlow\'s rule (half away from zero), and lists it', () => {
  it('8333.33, -8333.33, R 6172.84, 1.01, 2.68, -2.68, 1234.50, R0.13 (what LibreOffice also shows for these)', async () => {
    const out = await linesOf('rounding-en-za');
    expect(cents(out, '6000').slice(0, 8)).toEqual([833333, -833333, 617284, 101, 268, -268, 123450, 13]);
    expect(out.rounded).toEqual([
      { sheet: 'Sheet1', row: 2, column: 'C', value: 8333.33333333333, imported: '8333.33' },
      { sheet: 'Sheet1', row: 2, column: 'D', value: -8333.33333333333, imported: '-8333.33' },
      { sheet: 'Sheet1', row: 2, column: 'E', value: 12345.67 / 2, imported: '6172.84' },
      { sheet: 'Sheet1', row: 2, column: 'F', value: 1.005, imported: '1.01' },
      { sheet: 'Sheet1', row: 2, column: 'G', value: 2.675, imported: '2.68' },
      { sheet: 'Sheet1', row: 2, column: 'H', value: -2.675, imported: '-2.68' },
      { sheet: 'Sheet1', row: 2, column: 'J', value: 0.125, imported: '0.13' },
    ]);
  });

  it('General, 3 decimals, 0 decimals and 1 decimal keep the refusal', async () => {
    const reasons = (await linesOf('rounding-en-za')).lines.find((l) => l.accountCode === '4000')!.amounts.slice(0, 4).map((a) => (a.cell.kind === 'error' ? a.cell.reason : a.cell.kind));
    expect(reasons).toEqual([
      'has more than 2 decimals; round it to cents in the sheet (a free-form sheet is not rounded for you)',
      'has more than 2 decimals; round it to cents in the sheet (a free-form sheet is not rounded for you)',
      expect.stringMatching(/^This cell shows 0 decimal places but holds 83\.33/),
      expect.stringMatching(/^This cell shows 1 decimal place but holds 83\.33/),
    ]);
  });
});

describe('6: a total row with no code and the total word in the name column is skipped and listed', () => {
  it('Total and Grand total are skipped with their amounts', async () => {
    const out = await linesOf('total-name-en-za');
    expect([out.errors, out.lines.map((l) => l.accountCode)]).toEqual([[], ['6000', '4000']]);
    expect(out.skipped).toEqual([{ row: 4, reason: 'a total row', amounts: { '2026-03': '300.00' } }, { row: 5, reason: 'a total row', amounts: { '2026-03': '300.00' } }]);
  });

  it('a name that is no total word still refuses a row with amounts and no code', async () => {
    expect((await linesOf('total-name-refused-en-za')).errors).toEqual([{ row: 3, column: 'Account code', account: '', message: 'Sheet "Sheet1", row 3, column A: this row has amounts but no account code.' }]);
  });
});

describe('7: a merge entirely above the header row is allowed; any other merge refuses', () => {
  it('a title merged across A1:N1 above the header', async () => {
    const out = await linesOf('title-merge-en-za');
    expect(out.lines.map((l) => [l.row, l.accountCode, l.amounts[0]!.cell])).toEqual([[4, '6000', { kind: 'value', cents: 10000 }]]);
  });
  it.each([['merge-header-en-za', 'N1:O1'], ['merge-body-en-za', 'C2:D2']])('%s (%s) refuses', async (name, ref) => {
    await expect(linesOf(name)).rejects.toThrow(`Sheet "Sheet1" has merged cells (${ref}) on or below its header row: unmerge them, so each value is in its own row and month, and send it again (a title merged above the header is fine).`);
  });
});

describe('9: the sheet read is the one the workbook opens on', () => {
  it('a workbook saved open on its second sheet reads that sheet', async () => {
    const sheet = await sheetOf('active-sheet-en-za');
    expect(sheet.name).toBe('Budget');
    expect(freeformLines(model(), 'company', sheet).lines.map((l) => l.accountCode)).toEqual(['6000']);
  });
});

describe('10: "Mar-26" typed in en-ZA is a date (26 March 2026); the refusal says so', () => {
  it('Jan-27 read as 2026-01-27 is refused with what it was read as and what to type', async () => {
    await expect(linesOf('mar-26-en-za')).rejects.toThrow('Sheet "Sheet1", row 1, column M: the header is the date 2026-01-27 (a spreadsheet reads "Jan-27" as 27 January of this year), which is not a month of FY2027 (2026-03 to 2027-02); type the month as text, "Jan 2027" or 2027-01.');
  });
});

describe('low: a column under one character wide or a row under 3pt is hidden; only [Red] and [Black] colours', () => {
  it.each([['narrow-column-en-za', 'column D'], ['short-row-en-za', 'row 3']])('%s', async (name, what) => {
    await expect(readImportWorkbook(file(name))).rejects.toThrow(`has hidden rows or columns (${what})`);
  });
  it('[BLACK] is read; [BLUE] and [WHITE] are refused', async () => {
    const cells = (await linesOf('colours-en-us')).lines[0]!.amounts.slice(0, 4).map((a) => a.cell);
    expect(cells[0]).toEqual({ kind: 'value', cents: -500 });
    for (const c of cells.slice(1)) expect(c).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^This cell's number format/) });
  });
});


describe('round 8: a conditional format whose style sets a number format, font or fill refuses the sheet', () => {
  // LibreOffice's CSV export ignores conditional formats; its PDF of the same files shows 1500 / 250 as "2" / "0" under
  // #,##0, and nothing under ;;; (evidence doc). The reader cannot see a condition's outcome, so the sheet is refused.
  it.each(['cond-thousands-en-za', 'cond-hidden-en-za', 'cond-white-en-za', 'cond-fill-en-za'])('%s', async (name) => {
    await expect(linesOf(name)).rejects.toThrow('Sheet "Sheet1" has conditional formatting (C2:N2) on or below its header row whose style sets a number format, font or fill, so a condition could change how an amount reads: remove that conditional formatting (or move it above the header) and send it again.');
  });
  it.each([['cond-border-en-za', 2], ['cond-title-en-za', 3]])('%s (a border only; a white title above the header) is read', async (name, row) => {
    const out = await linesOf(name);
    expect(out.lines.map((l) => [l.row, l.amounts[0]!.cell])).toEqual([[row, { kind: 'value', cents: 150000 }]]);
  });
});
