/**
 * Budgets P3 PR-E: the board pack's income statement (page 6) prints Budget and Variance when the
 * company has a budget for the window. Each row's budget is the tracking engine's band or profit
 * total, copied (never summed from the rows above it); Variance is the actual less it; a line the
 * engine gives no budget prints n/m with the reason; the integrity gate refuses a variance that
 * does not foot or a budget that is not the engine's. The engine's figures themselves are proven on
 * real PostgreSQL in tests/integration/board-pack-budget.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { checkColumns } from '@/modules/accounting/services/packs/figures/packStatementIntegrity';
import { NO_BUDGET_FOR_LINE } from '@/modules/accounting/services/packs/pages/packStatementRows';
import type { PackPagesDocument, PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackBudgetFigures } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { brightsphereInput, demoInput, demoSet } from './fixtures/boardPackInputs';

function incomePage(doc: PackPagesDocument) {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'table' && block.table.rows.some((r) => r.key === 'is.revenue')) return { page, table: block.table };
    }
  }
  throw new Error('no income statement in this pack');
}
const withBudget = (budget: Partial<PackBudgetFigures> | null) => ({
  ...demoInput,
  set: { ...demoSet, budget: budget === null ? null : { ...demoSet.budget!, ...budget } },
});
const row = (t: PackTable, key: string) => t.rows.find((r) => r.key === key)!;

describe('page 6 Budget and Variance', () => {
  it('are declared after the comparative columns only when the company has a budget for the window', () => {
    expect(incomePage(buildBoardPackPages(demoInput)).table.columns).toEqual(
      ['actual', 'prior', 'change', 'changePct', 'pctOfRevenue', 'budget', 'variance']);
    expect(incomePage(buildBoardPackPages(withBudget(null))).table.columns).not.toContain('budget');
    expect(incomePage(buildBoardPackPages(brightsphereInput)).table.columns).not.toContain('variance');
  });

  it('copy every row\'s budget from the engine band, the profit totals included, and print actual less budget', () => {
    // A sentinel gross profit that is NOT revenue less cost of sales: the page must print the engine's figure.
    const bands = { ...demoSet.budget!.bands, 'is.grossProfit': 1_234_567 };
    const { table } = incomePage(buildBoardPackPages(withBudget({ bands })));
    for (const [key, budget] of Object.entries(bands)) {
      const r = row(table, key);
      expect(r.figures.budget?.value, key).toBe(budget);
      expect(r.figures.budget?.source, key).toMatch(/^budgetVariance\.[a-z_]+\.budget$/);
      expect(r.figures.variance?.value, key).toBeCloseTo((r.figures.actual!.value as number) - (budget as number), 6);
    }
    expect(row(table, 'is.grossProfit').figures.budget?.source).toBe('budgetVariance.gross_profit.budget');
    expect(row(table, 'is.revenue').figures.variance?.value).toBe(200_000);
  });

  it('print n/m with the reason where the engine states no budget, and a budgeted zero as a figure', () => {
    const bands = { ...demoSet.budget!.bands, 'is.otherIncome': null, 'is.operating': null, 'is.netProfit': null, 'is.otherExpenses': 0 };
    const { table } = incomePage(buildBoardPackPages(withBudget({ bands })));
    for (const key of ['is.otherIncome', 'is.operating', 'is.netProfit']) {
      for (const col of ['budget', 'variance'] as const) {
        expect(row(table, key).figures[col]?.value, `${key} ${col}`).toBeNull();
        expect(row(table, key).figures[col]?.unavailable, `${key} ${col}`).toBe(NO_BUDGET_FOR_LINE);
      }
    }
    expect(row(table, 'is.otherExpenses').figures.budget?.value).toBe(0);
    expect(row(table, 'is.otherExpenses').figures.variance?.value).toBe(15_000);
  });

  it('pass the integrity gate on the demo pack', () => {
    expect(() => assertPackIntegrity(buildBoardPackPages(demoInput))).not.toThrow();
  });

  it('name the budget in a footnote anchored on the Budget heading, numbered after the shared notes', () => {
    const { page, table } = incomePage(buildBoardPackPages(withBudget({ unbudgetedCount: 2 })));
    const note = table.columnNotes?.find((n) => n.column === 'budget');
    expect(note).toBeDefined();
    const text = page.footnotes?.find((f) => f.number === note!.footnote)?.text;
    expect(text).toBe('The budget column is the original budget (approved) for these months; variance is the actual '
      + 'less the budget. 2 accounts with actuals in the period have no budget, so their budget counts as nil.');
    const numbers = (page.footnotes ?? []).map((f) => f.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('say each financial year\'s primary budget when the window spans years, and print no user-typed version name', () => {
    const { page, table } = incomePage(buildBoardPackPages(withBudget({ version: null })));
    const number = table.columnNotes!.find((n) => n.column === 'budget')!.footnote;
    expect(page.footnotes!.find((f) => f.number === number)!.text).toBe(
      'The budget column is each financial year\'s primary budget for the months in it; variance is the actual less the budget.');
  });
});

describe('the gate on budget cells', () => {
  const demoTable = () => incomePage(buildBoardPackPages(demoInput)).table;
  const tamper = (t: PackTable, key: string, col: 'budget' | 'variance', patch: object): PackTable => ({
    ...t,
    rows: t.rows.map((r) => (r.key === key ? { ...r, figures: { ...r.figures, [col]: { ...r.figures[col]!, ...patch } } } : r)),
  });

  it('accepts the table as built', () => {
    expect(checkColumns(demoTable(), 'Page 6 table')).toEqual([]);
  });

  it('refuses a variance that is not the actual less the budget', () => {
    const failures = checkColumns(tamper(demoTable(), 'is.revenue', 'variance', { value: 1 }), 'Page 6 table');
    expect(failures).toEqual([expect.stringContaining("row 'Revenue' prints a variance of 1, but its actual less its budget is 200000")]);
  });

  it('refuses a budget worked out on the page rather than copied from the engine', () => {
    const failures = checkColumns(tamper(demoTable(), 'is.grossProfit', 'budget', { source: 'packStatementTables.budget.is.grossProfit' }), 'Page 6 table');
    expect(failures).toEqual([expect.stringContaining('which is not the budget engine\'s figure')]);
  });

  it('refuses a row printing another line\'s engine budget', () => {
    const failures = checkColumns(tamper(demoTable(), 'is.grossProfit', 'budget', { source: 'budgetVariance.net_profit.budget' }), 'Page 6 table');
    expect(failures).toEqual([expect.stringContaining("('budgetVariance.gross_profit.budget')")]);
  });

  it('refuses a variance printed against a budget the pack does not state', () => {
    const t = tamper(demoTable(), 'is.revenue', 'budget', { value: null, unavailable: 'x' });
    expect(checkColumns(t, 'Page 6 table')).toEqual([expect.stringContaining('against a budget or actual the pack does not state')]);
  });
});
