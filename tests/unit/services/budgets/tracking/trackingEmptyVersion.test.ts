/**
 * Review rounds 3-4 (R9, E1-E3): a year of the window is budget-ABSENT when its resolved version
 * contributes no budget row on an income-statement account within that year's window months, as
 * the scoped budget read returns them (so a row outside the window, on a balance-sheet account or
 * dated in another year's month never makes a year "budgeted"). FY* outside the window (a year to
 * date that has not started) is judged over its whole year, as the projection reads it.
 * Review r2 (R8): that is judged BEFORE the dimension filter. A year whose budget sits wholly at other
 * dimensions is budgeted, just not at this filter (`budgetOutsideFilterYears`).
 */
import { describe, expect, it } from 'vitest';
import { budgetAbsentYears, budgetOutsideFilterYears } from '@/modules/accounting/services/budgets/tracking/trackingBudgetRead';

const window = {
  years: [{ fiscalYear: 2026, months: ['2026-01', '2026-02'] }, { fiscalYear: 2027, months: ['2026-03', '2026-04'] }],
  fy: { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-04-30' },
};
const scope = [
  { fiscalYear: 2026, versionId: 'v26', first: '2026-01-01', last: '2026-02-01' },
  { fiscalYear: 2027, versionId: 'v27', first: '2026-03-01', last: '2027-04-01' },
];
const rows = (...months: string[]) => months.map((month) => ({ month, cls: 'included' as const }));

describe('budgetAbsentYears', () => {
  it('a year with rows in its window months is budgeted; one without is absent', () => {
    expect(budgetAbsentYears(window, scope, rows('2026-02', '2026-03'))).toEqual([]);
    expect(budgetAbsentYears(window, scope, rows('2026-03'))).toEqual([2026]);
  });

  it("FY*'s rows outside the window months do not budget the window", () => {
    // FY2027's only row is in Dec 2026: the window's FY2027 months (Mar, Apr) have none.
    expect(budgetAbsentYears(window, scope, rows('2026-01', '2026-12'))).toEqual([2027]);
  });

  it('a year with no version is absent', () => {
    expect(budgetAbsentYears(window, [scope[1]!, { ...scope[0]!, versionId: null }], rows('2026-01', '2026-03'))).toEqual([2026]);
  });

  it('FY* outside the window (not started) is judged over its whole year', () => {
    const notStarted = { years: [], fy: { fiscalYear: 2028, startDate: '2027-05-01', endDate: '2028-04-30' } };
    const s28 = [{ fiscalYear: 2028, versionId: 'v28', first: '2027-05-01', last: '2028-04-01' }];
    expect(budgetAbsentYears(notStarted, s28, rows('2028-01'))).toEqual([]);
    expect(budgetAbsentYears(notStarted, s28, [])).toEqual([2028]);
  });
});

describe('budgetAbsentYears under a filter (review r2, R8: judged BEFORE the filter)', () => {
  it('a budget row the filter classes as other or coarser still budgets its year; only a version with no row at all is absent', () => {
    expect(budgetAbsentYears(window, scope, [{ month: '2026-01', cls: 'other' }, { month: '2026-03', cls: 'included' }])).toEqual([]);
    expect(budgetAbsentYears(window, scope, [{ month: '2026-01', cls: 'coarser' }, { month: '2026-03', cls: 'included' }])).toEqual([]);
    expect(budgetAbsentYears(window, scope, [{ month: '2026-01', cls: 'other' }, { month: '2026-03', cls: 'other' }])).toEqual([]);
    expect(budgetAbsentYears(window, scope, [{ month: '2026-03', cls: 'other' }])).toEqual([2026]);
  });
});

describe('budgetOutsideFilterYears (review r2, R8)', () => {
  it('a year with a budget of which none is at the filter (every row other) is named; coarser rows are the footer\'s, included rows are the budget', () => {
    const rowsOf = (...r: Array<[string, 'included' | 'coarser' | 'other']>) => r.map(([month, cls]) => ({ month, cls }));
    expect(budgetOutsideFilterYears(window, scope, rowsOf(['2026-01', 'other'], ['2026-03', 'other']))).toEqual([2026, 2027]);
    expect(budgetOutsideFilterYears(window, scope, rowsOf(['2026-01', 'other'], ['2026-03', 'included']))).toEqual([2026]);
    expect(budgetOutsideFilterYears(window, scope, rowsOf(['2026-01', 'coarser'], ['2026-03', 'included']))).toEqual([]);
  });

  it('an absent year (no row at all, or no version) is not named: it has no budget, not a budget elsewhere', () => {
    expect(budgetOutsideFilterYears(window, scope, [{ month: '2026-03', cls: 'other' }])).toEqual([2027]);
    expect(budgetOutsideFilterYears(window, [scope[1]!, { ...scope[0]!, versionId: null }], [{ month: '2026-01', cls: 'other' }, { month: '2026-03', cls: 'other' }])).toEqual([2027]);
  });

  it('no filter, no year outside it', () => {
    expect(budgetOutsideFilterYears(window, scope, [{ month: '2026-01', cls: 'included' }, { month: '2026-03', cls: 'included' }])).toEqual([]);
  });
});
