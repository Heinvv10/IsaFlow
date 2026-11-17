/**
 * The free-form budget sheet (MCP budget tools PR 2, review round 2): a workbook that is not an IsaFlow template
 * (no _meta, no _base) read as an account-code column plus a column for every month of the version's year. The
 * header row is found by its account-code column ("Account code", "Code" or "Account", any case); months by
 * YYYY-MM, a date, or a month name that maps to exactly one year month; one dimension column at a cc1 / cc2 / bu
 * grain (decision 14: never two); a few information columns are ignored; anything else is refused with its sheet,
 * row and column. A blank cell KEEPS the version's amount; the text "clear" clears it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { freeformLines, type FreeCell, type FreeformSheet, type FreeRow } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { diffImportLines } from '@/modules/accounting/services/budgets/budgetImportDiff';
import type { RawCell } from '@/modules/accounting/services/budgets/budgetImportParse';
import { bandTotals } from '@/modules/accounting/services/budgets/gridTotals';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { CC1, MONTHS, RENT, SALES, TOKEN, model } from '../../mcp/budgetToolsFixture';

/** A cell as the raw-XML reader gives it: text, a General-formatted number, or empty. */
const cellOf = (c: RawCell): FreeCell | null => (c === null ? null : typeof c === 'number' ? { kind: 'number', value: c, format: 'General', plain: true, decimals: Infinity }
  : typeof c === 'string' ? { kind: 'text', text: c, format: 'General', plain: true } : { kind: 'bad', what: c.error });
const rowsOf = (rows: Array<{ row: number; cells: RawCell[] }>): FreeRow[] => rows.map((r) => ({ row: r.row, cells: r.cells.map(cellOf) }));
const sheet = (...rows: RawCell[][]): FreeformSheet => ({ name: 'Plan', rows: rowsOf(rows.map((cells, i) => ({ row: i + 1, cells }))) });
const linesOf = (m: GridReadModel, grain: 'company' | 'cc1', sh: FreeformSheet) => freeformLines(m, grain, sh).lines;
const NAMES = ['Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027'];
const vals = (set: Record<number, RawCell> = {}) => MONTHS.map((_, i) => (i in set ? set[i]! : null));

describe('the header row and its columns', () => {
  it.each([
    ['Account code + YYYY-MM', ['Account code', ...MONTHS]],
    ['code (lower case) + month names with years', ['code', ...NAMES]],
    ['ACCOUNT + dates (an Excel date header reads as YYYY-MM-DD)', ['ACCOUNT', ...MONTHS.map((m) => `${m}-01`)]],
    ['month names alone in a 12-month year, short and long', ['Code', 'March', 'Apr', 'May', 'June', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec', 'January', 'Feb']],
    ['two-digit years', ['Code', ...NAMES.map((n) => n.replace(' 20', '-'))]],
  ])('%s', (_n, header) => {
    const lines = linesOf(model(), 'company', sheet(['Budget FY2027'], header as RawCell[], ['6000', ...vals({ 1: 250 })]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ row: 3, accountCode: '6000', dimensionCode: null });
    expect(lines[0]!.amounts.map((a) => a.month)).toEqual(MONTHS);
    expect(lines[0]!.amounts[1]).toEqual({ month: '2026-04', cell: { kind: 'value', cents: 25000 } });
  });

  it('information columns are ignored (Account name, Description, Section, Total, Notes)', () => {
    const lines = linesOf(model(), 'company', sheet(['Code', 'Account name', 'Section', ...MONTHS, 'Total', 'Notes'], ['6000', 'Rent', 'Opex', ...vals({ 0: 1 }), 1, 'x']));
    expect(lines[0]!.amounts[0]!.cell).toEqual({ kind: 'value', cents: 100 });
  });

  it.each([
    ['no account-code column', [['Name', ...MONTHS]], /^Sheet "Plan": no header row with an account code column \("Account code", "Code" or "Account"\) in rows 1 to 20 of the sheet/],
    ['two account-code columns', [['Code', 'Code', ...MONTHS]], /^Sheet "Plan", row 1, columns A and B: both are an account code column/],
    ['an extra column', [['Code', ...MONTHS, 'Foo']], /^Sheet "Plan", row 1, column N: "Foo" is not an account code, dimension or month column of FY2027/],
    ['a month missing', [['Code', ...MONTHS.slice(0, 11)]], /^Sheet "Plan", row 1: no column for 2027-02 \(every month of FY2027 needs one; leave a cell blank to keep its amount\)/],
    ['a month twice', [['Code', ...MONTHS, 'Mar 2026']], /^Sheet "Plan", row 1, column N: 2026-03 is also column B/],
    ['a month outside the year', [['Code', ...MONTHS, '2027-03']], /^Sheet "Plan", row 1, column N: "2027-03" is not a month of FY2027 \(2026-03 to 2027-02\)/],
    ['a value under no header', [['Code', ...MONTHS], ['6000', ...vals(), 5]], /^Sheet "Plan", row 2, column N: a value under no header/],
    ['a dimension column on a company import', [['Code', 'CC1', ...MONTHS]], /^Sheet "Plan", row 1, column B: "CC1" names a dimension; a company-level import has none \(send grain cc1, cc2 or bu\)/],
  ])('refused: %s', (_n, rows, why) => {
    expect(() => linesOf(model(), 'company', sheet(...(rows as RawCell[][])))).toThrow(why);
  });

  it('a 14-month year: every month by year-qualified name; a month name alone that is two year months is refused as ambiguous', () => {
    const m14 = [...MONTHS, '2027-03', '2027-04'];
    const long = model({ year: { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-04-30', kind: 'transition', monthKeys: m14 } as never,
      totals: bandTotals(model().accounts, new Map(), 14) });
    const named = [...NAMES, 'Mar 2027', 'Apr 2027'];
    expect(linesOf(long, 'company', sheet(['Code', ...named], ['4000', ...m14.map(() => 1)]))[0]!.amounts).toHaveLength(14);
    expect(() => linesOf(long, 'company', sheet(['Code', 'Mar', ...named.slice(1)])))
      .toThrow(/^Sheet "Plan", row 1, column B: "Mar" is 2026-03 or 2027-03 in FY2027; write the year \(Mar 2026\) or YYYY-MM/);
  });

  it('decision 14: one dimension column at a dimension grain, never two; a dimension grain needs one', () => {
    const lines = linesOf(model(), 'cc1', sheet(['Code', 'Cost centre', ...MONTHS], ['4000', 'C1', ...vals({ 0: 3 })]));
    expect(lines[0]).toMatchObject({ accountCode: '4000', dimensionCode: 'C1' });
    expect(() => linesOf(model(), 'cc1', sheet(['Code', 'CC1', 'BU', ...MONTHS])))
      .toThrow(/^Sheet "Plan", row 1, column C: "BU" is a second dimension column; a budget amount carries at most one dimension \(decision 14\)/);
    expect(() => linesOf(model(), 'cc1', sheet(['Code', 'CC1', 'Dimension', ...MONTHS]))).toThrow(/second dimension column/);
    expect(() => linesOf(model(), 'cc1', sheet(['Code', ...MONTHS]))).toThrow(/^Sheet "Plan", row 1: a CC1 import needs a dimension column \("Dimension code", "CC1", "Cost centre"/);
  });
});

describe('cells: blank keeps, "clear" clears, an amount sets', () => {
  it('against the version as it is (the version token must be the one the sheet was sent with)', () => {
    const m = model({ cells: [...model().cells, { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 7, source: 'manual' }] });
    const lines = linesOf(m, 'company', sheet(['Code', ...MONTHS], ['6000', ...vals({ 0: 'Clear', 2: '12.50' })], ['4000', ...vals({ 3: 0 })]));
    expect(lines[0]!.amounts.slice(0, 3)).toEqual([
      { month: '2026-03', cell: { kind: 'blank' } }, { month: '2026-04', cell: { kind: 'blank' }, keep: true }, { month: '2026-05', cell: { kind: 'value', cents: 1250 } },
    ]);
    const { preview } = diffImportLines(m, { grain: 'company', readAt: TOKEN, base: 'current', lines });
    expect(preview.changes.map((c) => [c.key.split('|')[0], c.key.split('|')[4], c.before, c.after])).toEqual([
      [RENT, '2026-03', 100, null], [RENT, '2026-05', null, 12.5], [SALES, '2026-06', null, 0],
    ]); // Rent April (7) kept: its cell was blank
    expect([preview.conflicts, preview.warnings, preview.changes.some((c) => c.possibleRevert)]).toEqual([[], [], false]);
    expect(() => diffImportLines(m, { grain: 'company', readAt: '2026-11-16T09:00:00.000001Z', base: 'current', lines }))
      .toThrow(/^This budget was saved after the version_token this sheet was sent with/);
    expect(CC1).toBeTruthy();
  });

  it('per-row faults stay per row (the import\'s resolver): an unknown code, a cell that is not an amount', () => {
    const m: GridReadModel = model();
    const lines = linesOf(m, 'company', sheet(['Code', ...MONTHS], ['9999', ...vals({ 0: 1 })], ['6000', ...vals({ 1: 'abc' })]));
    const { preview } = diffImportLines(m, { grain: 'company', readAt: TOKEN, base: 'current', lines });
    expect(preview.errors.map((e) => [e.row, e.column])).toEqual([[2, 'Account code'], [3, '2026-04']]);
  });
});

describe('review round 3: what a free-form sheet must not read silently', () => {
  const at = (rows: Array<{ row: number; cells: RawCell[] }>): FreeformSheet => ({ name: 'Plan', rows: rowsOf(rows) });

  it('the template\'s own header without its hidden sheets is refused (its blanks would keep, not clear)', () => {
    expect(() => freeformLines(model(), 'company', sheet(['Section', 'Account code', 'Account name', ...MONTHS, 'FY total', 'PY actual'])))
      .toThrow(/^Sheet "Plan", row 1: this is an IsaFlow budget template without its hidden _meta and _base sheets; download a fresh one/);
  });

  it('the header is searched in rows 1 to 20 of the sheet, not the first 20 rows that hold something', () => {
    const rows = [{ row: 1, cells: ['Title'] }, { row: 21, cells: ['Code', ...MONTHS] }, { row: 22, cells: ['6000', ...vals({ 0: 1 })] }];
    expect(() => freeformLines(model(), 'company', at(rows))).toThrow(/no header row .* in rows 1 to 20 of the sheet/);
  });

  it('total rows and headings with no amounts are skipped and listed; a row with an amount and no code is refused; a heading with amounts reaches the resolver', () => {
    const out = freeformLines(model(), 'company', sheet(['Code', ...MONTHS], ['', ...vals({ 0: 5 })], ['Revenue', ...vals()], ['6000', ...vals({ 0: 1 })],
      ['Grand total', ...vals({ 0: 6 })], ['SUBTOTAL', ...vals({ 1: 1 })], ['Expenses', ...vals({ 0: 2 })]));
    expect(out.skipped).toEqual([
      { row: 3, reason: 'not an account, and no amounts (a heading?)' },
      { row: 5, reason: 'a total row', amounts: { '2026-03': '6.00' } }, { row: 6, reason: 'a total row', amounts: { '2026-04': '1.00' } }, // round 5: listed with its amounts
    ]);
    expect(out.errors).toEqual([{ row: 2, column: 'Account code', account: '', message: 'Sheet "Plan", row 2, column A: this row has amounts but no account code.' }]); // round 4: money is never skipped
    expect(out.lines.map((l) => l.accountCode)).toEqual(['6000', 'Expenses']); // "Expenses" with an amount reaches the resolver, which refuses it
  });

  it('a numeric code that lost its leading zero: refused, never guessed; ambiguous when both codes exist', () => {
    const padded = model({ accounts: [...model().accounts, { ...model().accounts[0]!, id: '20000000-0000-4000-8000-0000000000a1', code: '0400', name: 'Fees' }] });
    const lost = freeformLines(padded, 'company', sheet(['Code', ...MONTHS], [400, ...vals({ 0: 1 })], ['0400', ...vals({ 0: 1 })]));
    expect(lost.errors).toEqual([{ row: 2, column: 'Account code', account: '400', message: 'Account code 400 is a number: it lost its leading zero (0400?). Format the code column as text and type the code.' }]);
    expect(lost.lines.map((l) => l.accountCode)).toEqual(['0400']);
    const both = model({ accounts: [...padded.accounts, { ...model().accounts[0]!, id: '20000000-0000-4000-8000-0000000000a2', code: '400', name: 'Other' }] });
    expect(freeformLines(both, 'company', sheet(['Code', ...MONTHS], [400, ...vals({ 0: 1 })])).errors[0]!.message)
      .toBe('Account code 400 is a number and could be 400 or 0400 (a lost leading zero). Format the code column as text and type the code.');
  });

  it('a number with more than 2 decimals is refused per cell (the template import rounds; a free-form sheet does not); float noise is not', () => {
    const [line] = freeformLines(model(), 'company', sheet(['Code', ...MONTHS], ['6000', ...vals({ 0: 1.005, 1: 1.1, 2: 0.07 })])).lines;
    expect(line!.amounts[0]!.cell).toEqual({ kind: 'error', raw: '1.005', reason: 'has more than 2 decimals; round it to cents in the sheet (a free-form sheet is not rounded for you)' });
    expect(line!.amounts.slice(1, 3).map((a) => a.cell)).toEqual([{ kind: 'value', cents: 110 }, { kind: 'value', cents: 7 }]);
  });

  it('round 5: a numeric dimension code that lost its leading zero is refused, as an account code is', () => {
    const m = model({ dimensions: { cc1: [{ id: CC1, code: '07', name: 'Seven', isActive: true }], cc2: [], bu: [] } });
    const out = freeformLines(m, 'cc1', sheet(['Code', 'CC1', ...MONTHS], ['4000', 7, ...vals({ 0: 1 })], ['4000', '07', ...vals({ 0: 2 })]));
    expect(out.errors).toEqual([{ row: 2, column: 'Dimension code', account: '4000', message: 'Dimension code 7 is a number: it lost its leading zero (07?). Format the dimension column as text and type the code.' }]);
    expect(out.lines.map((l) => [l.row, l.dimensionCode])).toEqual([[3, '07']]);
  });

  it('round 5: a value above the header row under a month column refuses (every amount is on an account\'s row); text elsewhere above it is ignored', () => {
    expect(() => freeformLines(model(), 'company', sheet(['Budget 2027', null, 5], ['Code', ...MONTHS])))
      .toThrow(/^Sheet "Plan", row 1, column C: a value above the header row, under a month column/);
    expect(freeformLines(model(), 'company', sheet(['Budget 2027', 'as agreed'], ['Code', 'Notes', ...MONTHS], ['6000', 'x', 1])).lines).toHaveLength(1);
  });

  // Boolean / error / date-formatted cells, merges and hidden layout are the raw-XML reader's: budgetFreeformRaw.test.ts.
});
