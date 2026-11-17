/**
 * Review round 9 (blind code review) on the free-form budget sheet (MCP budget tools PR 2):
 *  - whether a value holds more decimals is decided on its 15 significant digits, as `roundToCents` rounds, not by a
 *    float tolerance on value x 100 (169762805.95 x 100 is 16976280594.999998: an exact-cent value was refused);
 *  - a format's decimals are those of the SECTION that draws the value (the first for a positive, the second for a
 *    negative when there is one; the zero section never counts);
 *  - the structural guards: rows out of order, a cell not where its row says (a second B2 would overwrite the
 *    first), a sheet that is not a plain worksheet, styles or shared strings where no program writes them;
 *  - every refusal names its sheet, row and column; an error value in the dimension column is said to be one.
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { amountCell } from '@/modules/accounting/services/budgets/budgetFreeformAmounts';
import { readImportWorkbook } from '@/modules/accounting/services/budgets/budgetImportFreeformRead';
import { freeformLines, type FreeCell } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { CC1, MONTHS, model } from '../../mcp/budgetToolsFixture';
import { rawBook, rowXml, sheetBody, stylesWith, type RawCellSpec } from './rawXlsxFixture';

const num = (value: number, decimals: number): FreeCell => ({ kind: 'number', value, format: decimals === Infinity ? 'General' : `${decimals} decimals`, plain: true, decimals });
function read(value: number, decimals: number) {
  const rounded: string[] = [];
  const cell = amountCell('2026-03', num(value, decimals), (_v, imported) => rounded.push(imported)).cell;
  return { cell, rounded };
}

describe('M1: more than cents is decided on 15 significant digits', () => {
  it.each([[134221993.55, 13422199355], [169762805.95, 16976280595], [12345678901.23, 1234567890123], [-98765432109.87, -9876543210987]])('%s is %s cents, General and 2 decimals, not rounded', (value, cents) => {
    for (const d of [Infinity, 2]) expect(read(value, d)).toEqual({ cell: { kind: 'value', cents }, rounded: [] });
  });

  it('1 and 0 decimals: 134221993.5 under one decimal, 169762805 under none, are read', () => {
    expect(read(134221993.5, 1).cell).toEqual({ kind: 'value', cents: 13422199350 });
    expect(read(169762805, 0).cell).toEqual({ kind: 'value', cents: 16976280500 });
  });

  it('a sweep of 20 000 random cent values below 1e11: every one is read exactly, none refused or listed as rounded', () => {
    let seed = 20261117;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const bad: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const cents = Math.floor(next() * 1e13) * (next() < 0.5 ? -1 : 1);
      const value = cents / 100;
      for (const d of [Infinity, 2]) {
        const r = read(value, d);
        if (r.cell.kind !== 'value' || r.cell.cents !== cents || r.rounded.length > 0) bad.push(`${value} @${d}: ${JSON.stringify(r)}`);
      }
      const tenths = Math.round(cents / 10) / 10; // whole tenths under one decimal
      const t = read(tenths, 1);
      if (t.cell.kind !== 'value' || t.cell.cents !== Math.round(tenths * 100)) bad.push(`${tenths} @1: ${JSON.stringify(t)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

async function cellWith(code: string, value: number) {
  const buf = await rawBook({ sheets: [{ name: 'Budget', body: sheetBody(rowXml(1, ['Code', ...MONTHS]) + rowXml(2, ['6000', { n: value, s: 1 }])) }], activeTab: 0, styles: stylesWith([0, 164], { 164: code }) });
  const r = await readImportWorkbook(buf);
  if (r.kind !== 'freeform') throw new Error('not free-form');
  const rounded: unknown[] = [];
  const out = freeformLines(model(), 'company', r.sheet);
  rounded.push(...out.rounded.map((x) => x.imported));
  return { cell: out.lines[0]!.amounts[0]!.cell, rounded };
}

describe('L: a format\'s decimals are the section that draws the value', () => {
  it('the zero section never counts: 1.50 under #,##0.00;-#,##0.00;0 is read', async () => {
    expect((await cellWith('#,##0.00;-#,##0.00;0', 1.5)).cell).toEqual({ kind: 'value', cents: 150 });
    expect((await cellWith('#,##0.00;-#,##0.00;0', -1.5)).cell).toEqual({ kind: 'value', cents: -150 });
  });
  it('0.00;-0.0: a positive shows 2 (1.25 read), a negative 1 (-1.25 refused)', async () => {
    expect((await cellWith('0.00;-0.0', 1.25)).cell).toEqual({ kind: 'value', cents: 125 });
    expect((await cellWith('0.00;-0.0', -1.25)).cell).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^This cell shows 1 decimal place but holds -1.25/) });
  });
  it('0.000;-0.00: a negative with 3 decimals is rounded and listed, a positive is refused', async () => {
    expect(await cellWith('0.000;-0.00', -1.234)).toEqual({ cell: { kind: 'value', cents: -123 }, rounded: ['-1.23'] });
    expect((await cellWith('0.000;-0.00', 1.234)).cell).toMatchObject({ kind: 'error', raw: '1.234' });
  });
});

const HEAD = rowXml(1, ['Code', ...MONTHS]);
const book = (body: string) => rawBook({ sheets: [{ name: 'Budget', body }], activeTab: 0 });
async function zipEdit(buf: Buffer, part: string, edit: (s: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  zip.file(part, edit(await zip.file(part)!.async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('M2: the structural guards', () => {
  it('rows out of order refuse the file', async () => {
    await expect(readImportWorkbook(await book(sheetBody(HEAD + rowXml(3, ['4000', 1]) + rowXml(2, ['6000', 2]))))).rejects.toThrow(/^Sheet "Budget": its rows are out of order \(row 2\)/);
  });
  it.each([
    ['a second B2 (it would overwrite the first)', ['6000', { raw: '<c r="B2"><v>5</v></c>' }, { raw: '<c r="B2"><v>7</v></c>' }]],
    ['a cell of another row', ['6000', { raw: '<c r="B3"><v>5</v></c>' }]],
  ] as Array<[string, RawCellSpec[]]>)('%s refuses the file', async (_n, cells) => {
    await expect(readImportWorkbook(await book(sheetBody(HEAD + rowXml(2, cells))))).rejects.toThrow(/^Sheet "Budget": cell B[23] is not where its row says/);
  });
  it('a sheet that is not a plain worksheet refuses the file', async () => {
    const buf = await zipEdit(await book(sheetBody(HEAD)), 'xl/_rels/workbook.xml.rels', (s) => s.replace('Target="worksheets/sheet1.xml"', 'Target="chartsheets/sheet1.xml"'));
    await expect(readImportWorkbook(buf)).rejects.toThrow('Sheet "Budget" is not a plain worksheet, so it cannot be read as a budget sheet.');
  });
  it('styles where no spreadsheet program writes them refuse the file', async () => {
    const buf = await zipEdit(await rawBook({ sheets: [{ name: 'Budget', body: sheetBody(HEAD) }], activeTab: 0, styles: stylesWith([0]) }), 'xl/_rels/workbook.xml.rels', (s) => s.replace('Target="styles.xml"', 'Target="../styles.xml"'));
    await expect(readImportWorkbook(buf)).rejects.toThrow('This workbook\'s styles or shared strings are where no spreadsheet program writes them.');
  });
});

describe('L: every refusal names its sheet, row and column', () => {
  const text = (t: string): FreeCell => ({ kind: 'text', text: t, format: 'General', plain: true });
  const gen = (v: number): FreeCell => num(v, Infinity);
  it('a lost leading zero, account and dimension', () => {
    const m = model({
      accounts: [...model().accounts, { ...model().accounts[0]!, id: '20000000-0000-4000-8000-0000000000a1', code: '0400', name: 'Fees' }],
      dimensions: { cc1: [{ id: CC1, code: '010', name: 'Ten', isActive: true }], cc2: [], bu: [] } as never,
    });
    const sheet = { name: 'Plan', rows: [
      { row: 1, cells: [text('Code'), text('CC1'), ...MONTHS.map(text)] },
      { row: 2, cells: [gen(400), text('010'), text('5')] },
      { row: 3, cells: [text('6000'), gen(10), text('5')] },
    ] };
    expect(freeformLines(m, 'cc1', sheet).errors.map((e) => e.message)).toEqual([
      'Sheet "Plan", row 2, column A: Account code 400 is a number: it lost its leading zero (0400?). Format the code column as text and type the code.',
      'Sheet "Plan", row 3, column B: Dimension code 10 is a number: it lost its leading zero (010?). Format the dimension column as text and type the code.',
    ]);
  });
  it('an error value in the dimension column is refused as one', () => {
    const sheet = { name: 'Plan', rows: [
      { row: 1, cells: [text('Code'), text('CC1'), ...MONTHS.map(text)] },
      { row: 2, cells: [text('6000'), { kind: 'bad', what: 'an error value (#N/A: a formula that failed)' } as FreeCell, text('5')] },
    ] };
    expect(freeformLines(model(), 'cc1', sheet).errors).toEqual([{ row: 2, column: 'Dimension code', account: '6000', message: 'Sheet "Plan", row 2, column B: the dimension code is an error value (#N/A: a formula that failed), not a code.' }]);
  });
});
