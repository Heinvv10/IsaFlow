/**
 * The one file for `statementRows/comparators.ts`.
 *
 * It used to be two — this one and `../statementComparators.test.ts` — which
 * asserted the same zero-base rule and the same favourable-signing rule with
 * different fixtures. Two files means a rule can be changed in the service and
 * only one of them notices, and the two disagreeing is how a reader learns the
 * contract is unclear rather than which behaviour is right.
 */
import { describe, it, expect } from 'vitest';
import {
  applyBudgetComparator, applyTrend, baseComparison,
} from '@/modules/accounting/services/reports/statementRows/comparators';
import { toBalanceSheetRows } from '@/modules/accounting/services/reports/statementRows/balanceSheetRows';
import { comparativeOnlyColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';

const MONTHS = [
  '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
  '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
];

/** A statement shaped like the real thing: a band header, two coded lines and
 *  a subtotal. Only the two coded lines may ever carry a comparator. */
const ROWS: StatementRow[] = [
  { id: 'sec:revenue', kind: 'section', label: 'Turnover', depth: 0, actual: 900_000 },
  { id: 'acc:1000', kind: 'line', label: 'Sales', depth: 1, accountCode: '1000', actual: 900_000 },
  { id: 'acc:6000', kind: 'line', label: 'Rent', depth: 1, accountCode: '6000', actual: 130_000 },
  { id: 'sub:revenue', kind: 'subtotal', label: 'Total Turnover', depth: 0, actual: 900_000 },
];

function line(row: Partial<StatementRow> & { id: string; label: string; actual: number }): StatementRow {
  return { kind: 'line', depth: 1, ...row } as StatementRow;
}

function budgetLine(overrides: Partial<BudgetVsActualLine>): BudgetVsActualLine {
  return {
    account_code: '6000',
    account_name: 'Salaries',
    account_type: 'expense',
    budget_amount: 0,
    actual_amount: 0,
    variance: 0,
    variance_pct: 0,
    ...overrides,
  };
}

const LINES = buildBudgetVsActualLines(
  [
    { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900_000 },
    { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 130_000 },
  ],
  { '1000': 1_000_000, '6000': 120_000 },
);

describe('applyTrend', () => {
  const trends: AccountTrends = {
    months: MONTHS,
    byAccountCode: { '1000': MONTHS.map((_, i) => i * 1000) },
    unavailable: {},
  };

  it('attaches the twelve figures to the row with that account code', () => {
    expect(applyTrend(ROWS, trends)[1]!.trend).toEqual(trends.byAccountCode['1000']);
  });

  it('leaves a row with no trend data undefined rather than inventing zeros', () => {
    expect(applyTrend(ROWS, trends)[2]!.trend).toBeUndefined();
  });

  it('never puts a trend on a section, subtotal or total row', () => {
    const out = applyTrend(ROWS, {
      months: MONTHS, byAccountCode: { '1000': MONTHS.map(() => 1) }, unavailable: {},
    });
    expect(out[0]!.trend).toBeUndefined();
    expect(out[3]!.trend).toBeUndefined();
  });

  it('does not mutate the rows it was given', () => {
    applyTrend(ROWS, trends);
    expect(ROWS[1]!.trend).toBeUndefined();
  });

  it('leaves trend undefined for an account the service flags unavailable, never twelve zeros', () => {
    // Retained earnings is the case: the balance sheet injects a derived
    // residual onto it, so its posted lines are flat at zero beside a printed
    // figure in the millions.
    const rows = [...ROWS, line({ id: 'acc:6000-re', label: 'Retained Earnings', accountCode: '6000', actual: 50_000 })];
    const out = applyTrend(rows, {
      months: MONTHS,
      byAccountCode: { '1000': MONTHS.map((_, i) => i * 1000), '6000': MONTHS.map(() => 7) },
      unavailable: { '6000': 'derived balance, not posted' },
    });
    expect(out[4]!.trend).toBeUndefined();
    expect(out[2]!.trend).toBeUndefined();
  });
});

describe('applyBudgetComparator', () => {
  it('copies the budget figure onto the row', () => {
    const out = applyBudgetComparator(ROWS, LINES);
    expect(out[1]!.budget?.value).toBe(1_000_000);
    expect(out[2]!.budget?.value).toBe(120_000);
  });

  it('reports the MOVEMENT, actual minus budget, like every other comparator', () => {
    const out = applyBudgetComparator(ROWS, LINES);
    expect(out[1]!.budget?.variance).toBe(-100_000); // 900k actual vs 1.0m budget
    expect(out[2]!.budget?.variance).toBe(10_000);   // 130k actual vs 120k budget
  });

  it('takes polarity from the service, so an overspent expense is unfavourable even though its movement is positive', () => {
    const out = applyBudgetComparator(ROWS, LINES);
    expect(out[1]!.budget?.favourable).toBe(false); // revenue under budget
    expect(out[2]!.budget?.favourable).toBe(false); // expense over budget
  });

  it('marks a favourable line favourable', () => {
    const good = buildBudgetVsActualLines(
      [{ id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 110_000 }],
      { '6000': 120_000 },
    );
    const out = applyBudgetComparator(ROWS, good);
    expect(out[2]!.budget?.favourable).toBe(true);
    expect(out[2]!.budget?.variance).toBe(-10_000);
  });

  it('signs variancePct the same way as variance (actual − budget), never the service favourable-signed one', () => {
    // Rent: budget 100, actual 150. The service's own `variance_pct` is
    // favourably signed for an expense (budget − actual → -50%), which would
    // print alongside a +R50 movement. variancePct must share variance's sign
    // convention — up is positive — so it reads +50.0% here, with
    // `favourable: false` carrying the judgement instead.
    const expenseLines = buildBudgetVsActualLines(
      [{ id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 150 }],
      { '6000': 100 },
    );
    const [, , expenseOut] = applyBudgetComparator(ROWS, expenseLines);
    expect(expenseOut!.budget?.variance).toBe(50);
    expect(expenseOut!.budget?.variancePct).toBe(50);
    expect(expenseOut!.budget?.favourable).toBe(false);

    // Same numbers on a revenue line: up is favourable, so the sign and the
    // judgement agree.
    const revenueLines = buildBudgetVsActualLines(
      [{ id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 150 }],
      { '1000': 100 },
    );
    const [, revenueOut] = applyBudgetComparator(ROWS, revenueLines);
    expect(revenueOut!.budget?.variance).toBe(50);
    expect(revenueOut!.budget?.variancePct).toBe(50);
    expect(revenueOut!.budget?.favourable).toBe(true);
  });

  it('omits variancePct when the budget base is exactly zero', () => {
    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 5500 })];
    const lines = [
      budgetLine({ account_code: '6000', budget_amount: 0, actual_amount: 5500, variance: -5500, variance_pct: 0 }),
    ];

    const [result] = applyBudgetComparator(rows, lines);

    expect(result.budget).toBeDefined();
    expect(result.budget!.value).toBe(0);
    expect(result.budget!.variance).toBe(5500);
    expect(result.budget!.variancePct).toBeUndefined();
  });

  it('rounds the actual-less-budget subtraction to the cent, killing float noise', () => {
    // 130000.10 − 120000.20 evaluates to 9999.899999999994 in IEEE-754. Both
    // operands are rands to the cent, so the only thing round2 can remove is
    // that noise — and without it the screen prints a figure the export,
    // re-deriving the same subtraction, would round differently.
    expect(130_000.1 - 120_000.2).not.toBe(9999.9);

    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 130_000.1 })];
    const lines = [
      budgetLine({
        account_code: '6000', budget_amount: 120_000.2, actual_amount: 130_000.1,
        variance: -9999.9, variance_pct: -8.33,
      }),
    ];

    const [result] = applyBudgetComparator(rows, lines);

    expect(result.budget!.variance).toBe(9999.9);
  });

  it('leaves an unbudgeted row, and every band row, without a budget comparison', () => {
    const out = applyBudgetComparator(ROWS, LINES.filter((l) => l.account_code === '1000'));
    expect(out[0]!.budget).toBeUndefined(); // section
    expect(out[2]!.budget).toBeUndefined(); // coded line with no budget line
    expect(out[3]!.budget).toBeUndefined(); // subtotal
  });

  it('does not mutate the rows it was given', () => {
    applyBudgetComparator(ROWS, LINES);
    expect(ROWS[1]!.budget).toBeUndefined();
  });
});

describe('baseComparison', () => {
  const fav = (v: number) => v >= 0;

  it('keeps the movement against a zero base, and drops only the percentage', () => {
    // Nothing to R500 000 IS a movement of R500 000, and it is the reader's
    // whole interest in the row. The percentage is the only figure that does
    // not exist — no denominator — and the services' 0 is a placeholder for
    // it, which the grid would otherwise print as "0.0%": a claim of no change
    // beside the largest movement on the statement.
    const c = baseComparison(0, 500_000, fav);
    expect(c.value).toBe(0);
    expect(c.variance).toBe(500_000);
    expect(c.favourable).toBe(true);
    expect(c.variancePct).toBeUndefined();
  });

  it('still judges polarity against a zero base', () => {
    expect(baseComparison(0, -500_000, fav).favourable).toBe(false);
  });

  it('computes the movement as a percentage of the base when the base is a real figure', () => {
    expect(baseComparison(400_000, 100_000, fav))
      .toEqual({ value: 400_000, variance: 100_000, variancePct: 25, favourable: true });
  });

  it('judges polarity from the movement, not from the value', () => {
    expect(baseComparison(400_000, -100_000, fav).favourable).toBe(false);
  });

  it('leaves favourable and variancePct undefined when the service reported no variance', () => {
    const c = baseComparison(400_000, undefined, fav);
    expect(c.favourable).toBeUndefined();
    expect(c.variancePct).toBeUndefined();
  });
});

describe('the balance-sheet adapter applies the zero-base rule', () => {
  it('keeps the movement but drops the percentage when the prior balance was zero', () => {
    const report = {
      assets: [{ accountCode: '1110', accountName: 'Bank', balance: -3_184_600, priorBalance: 0, variance: -3_184_600, variancePct: 0 }],
      liabilities: [], equity: [],
      totalAssets: -3_184_600, totalLiabilities: 0, totalEquity: 0,
    } as unknown as Parameters<typeof toBalanceSheetRows>[0];
    const { assets } = toBalanceSheetRows(report, { comparative: true });
    const bank = assets.find(r => r.accountCode === '1110')!;
    expect(bank.prior?.variance).toBe(-3_184_600);
    expect(bank.prior?.variancePct).toBeUndefined();
  });
});

describe('comparativeOnlyColumns', () => {
  it('is the one fallback both statement bodies use', () => {
    expect(comparativeOnlyColumns(true))
      .toEqual({ prior: true, budget: false, variance: true, trend: false });
    expect(comparativeOnlyColumns(false))
      .toEqual({ prior: false, budget: false, variance: false, trend: false });
  });

  it('never leaves a variance column with no comparator behind it', () => {
    // Four empty cells per row read as missing data, not as "off".
    for (const showComparative of [true, false]) {
      const c = comparativeOnlyColumns(showComparative);
      expect(c.variance && !c.prior && !c.budget).toBe(false);
    }
  });
});
