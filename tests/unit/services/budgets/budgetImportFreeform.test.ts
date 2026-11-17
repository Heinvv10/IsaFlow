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

import { freeformLines } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { diffImportLines } from '@/modules/accounting/services/budgets/budgetImportDiff';
import type { RawCell, SheetRow } from '@/modules/accounting/services/budgets/budgetImportParse';
import { bandTotals } from '@/modules/accounting/services/budgets/gridTotals';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { CC1, MONTHS, RENT, SALES, TOKEN, model } from '../../mcp/budgetToolsFixture';

const sheet = (...rows: RawCell[][]): SheetRow[] => rows.map((cells, i) => ({ row: i + 1, cells }));
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
    const lines = freeformLines(model(), 'company', sheet(['Budget FY2027'], header as RawCell[], ['6000', ...vals({ 1: 250 })]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ row: 3, accountCode: '6000', dimensionCode: null });
    expect(lines[0]!.amounts.map((a) => a.month)).toEqual(MONTHS);
    expect(lines[0]!.amounts[1]).toEqual({ month: '2026-04', cell: { kind: 'value', cents: 25000 } });
  });

  it('information columns are ignored (Account name, Description, Section, Total, Notes)', () => {
    const lines = freeformLines(model(), 'company', sheet(['Code', 'Account name', 'Section', ...MONTHS, 'Total', 'Notes'], ['6000', 'Rent', 'Opex', ...vals({ 0: 1 }), 1, 'x']));
    expect(lines[0]!.amounts[0]!.cell).toEqual({ kind: 'value', cents: 100 });
  });

  it.each([
    ['no account-code column', [['Name', ...MONTHS]], /^First sheet: no header row with an account code column \("Account code", "Code" or "Account"\) in its first 20 rows/],
    ['two account-code columns', [['Code', 'Code', ...MONTHS]], /^First sheet, row 1, columns A and B: both are an account code column/],
    ['an extra column', [['Code', ...MONTHS, 'Foo']], /^First sheet, row 1, column N: "Foo" is not an account code, dimension or month column of FY2027/],
    ['a month missing', [['Code', ...MONTHS.slice(0, 11)]], /^First sheet, row 1: no column for 2027-02 \(every month of FY2027 needs one; leave a cell blank to keep its amount\)/],
    ['a month twice', [['Code', ...MONTHS, 'Mar 2026']], /^First sheet, row 1, column N: 2026-03 is also column B/],
    ['a month outside the year', [['Code', ...MONTHS, '2027-03']], /^First sheet, row 1, column N: "2027-03" is not a month of FY2027 \(2026-03 to 2027-02\)/],
    ['a value under no header', [['Code', ...MONTHS], ['6000', ...vals(), 5]], /^First sheet, row 2, column N: a value under no header/],
    ['a dimension column on a company import', [['Code', 'CC1', ...MONTHS]], /^First sheet, row 1, column B: "CC1" names a dimension; a company-level import has none \(send grain cc1, cc2 or bu\)/],
  ])('refused: %s', (_n, rows, why) => {
    expect(() => freeformLines(model(), 'company', sheet(...(rows as RawCell[][])))).toThrow(why);
  });

  it('a 14-month year: every month by year-qualified name; a month name alone that is two year months is refused as ambiguous', () => {
    const m14 = [...MONTHS, '2027-03', '2027-04'];
    const long = model({ year: { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-04-30', kind: 'transition', monthKeys: m14 } as never,
      totals: bandTotals(model().accounts, new Map(), 14) });
    const named = [...NAMES, 'Mar 2027', 'Apr 2027'];
    expect(freeformLines(long, 'company', sheet(['Code', ...named], ['4000', ...m14.map(() => 1)]))[0]!.amounts).toHaveLength(14);
    expect(() => freeformLines(long, 'company', sheet(['Code', 'Mar', ...named.slice(1)])))
      .toThrow(/^First sheet, row 1, column B: "Mar" is 2026-03 or 2027-03 in FY2027; write the year \(Mar 2026\) or YYYY-MM/);
  });

  it('decision 14: one dimension column at a dimension grain, never two; a dimension grain needs one', () => {
    const lines = freeformLines(model(), 'cc1', sheet(['Code', 'Cost centre', ...MONTHS], ['4000', 'C1', ...vals({ 0: 3 })]));
    expect(lines[0]).toMatchObject({ accountCode: '4000', dimensionCode: 'C1' });
    expect(() => freeformLines(model(), 'cc1', sheet(['Code', 'CC1', 'BU', ...MONTHS])))
      .toThrow(/^First sheet, row 1, column C: "BU" is a second dimension column; a budget amount carries at most one dimension \(decision 14\)/);
    expect(() => freeformLines(model(), 'cc1', sheet(['Code', 'CC1', 'Dimension', ...MONTHS]))).toThrow(/second dimension column/);
    expect(() => freeformLines(model(), 'cc1', sheet(['Code', ...MONTHS]))).toThrow(/^First sheet, row 1: a CC1 import needs a dimension column \("Dimension code", "CC1", "Cost centre"/);
  });
});

describe('cells: blank keeps, "clear" clears, an amount sets', () => {
  it('against the version as it is (the version token must be the one the sheet was sent with)', () => {
    const m = model({ cells: [...model().cells, { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 7, source: 'manual' }] });
    const lines = freeformLines(m, 'company', sheet(['Code', ...MONTHS], ['6000', ...vals({ 0: 'Clear', 2: '12.50' })], ['4000', ...vals({ 3: 0 })]));
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
    const lines = freeformLines(m, 'company', sheet(['Code', ...MONTHS], ['9999', ...vals({ 0: 1 })], ['6000', ...vals({ 1: 'abc' })]));
    const { preview } = diffImportLines(m, { grain: 'company', readAt: TOKEN, base: 'current', lines });
    expect(preview.errors.map((e) => [e.row, e.column])).toEqual([[2, 'Account code'], [3, '2026-04']]);
  });
});
