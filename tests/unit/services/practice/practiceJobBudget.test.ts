/**
 * Engagement Budget thresholds (pure). The firm partner's question is "how much
 * of the approved value for this engagement is still available to spend on
 * time?" — so the balance is the budget less everything consumed, and the
 * state warns (amber) from 80% used and goes red only once the balance is
 * negative. A NULL budget is "No budget", never R0.
 */
import { describe, it, expect } from 'vitest';
import { budgetFigures, normaliseBudgetAmount, JobBudgetInvalidError, MAX_BUDGET } from '@/modules/accounting/services/practice/practiceJobBudget';

describe('budgetFigures', () => {
  it('a job with no budget has state none and no balance or percentage', () => {
    expect(budgetFigures(null, 1234.5)).toEqual({ balance: null, percentUsed: null, state: 'none' });
  });

  it('below 80% used is ok, and the balance is what remains', () => {
    expect(budgetFigures(10000, 7000)).toEqual({ balance: 3000, percentUsed: 70, state: 'ok' });
  });

  it('a cent under 80% is still ok', () => {
    expect(budgetFigures(1000, 799.99).state).toBe('ok');
  });

  it('exactly 80% used is a warning', () => {
    expect(budgetFigures(1000, 800)).toEqual({ balance: 200, percentUsed: 80, state: 'warning' });
  });

  it('fully used (balance exactly zero) is a warning, not over', () => {
    expect(budgetFigures(1000, 1000)).toEqual({ balance: 0, percentUsed: 100, state: 'warning' });
  });

  it('one cent over the budget is over, with a negative balance', () => {
    expect(budgetFigures(1000, 1000.01)).toEqual({ balance: -0.01, percentUsed: 100, state: 'over' });
  });

  it('well over budget reports the overrun as a negative balance', () => {
    expect(budgetFigures(500, 1000)).toEqual({ balance: -500, percentUsed: 200, state: 'over' });
  });

  it('works in cents, so float noise does not move a threshold', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in cents it is exact.
    expect(budgetFigures(0.3, 0.1 + 0.2)).toEqual({ balance: 0, percentUsed: 100, state: 'warning' });
  });

  it('a zero budget with nothing consumed has no percentage and is a warning', () => {
    expect(budgetFigures(0, 0)).toEqual({ balance: 0, percentUsed: null, state: 'warning' });
  });

  it('rounds the percentage to one decimal: a third used is 33.3%', () => {
    expect(budgetFigures(300, 100).percentUsed).toBe(33.3);
    expect(budgetFigures(300, 200).percentUsed).toBe(66.7);
  });

  it('keeps cents exact at the largest accepted budget, and one cent over is over', () => {
    const max = 9999999999999.99;
    expect(budgetFigures(max, 0)).toEqual({ balance: max, percentUsed: 0, state: 'ok' });
    expect(budgetFigures(max, max + 0.01)).toMatchObject({ balance: -0.01, state: 'over' });
  });

  it('a zero budget with time on it is over', () => {
    expect(budgetFigures(0, 50)).toEqual({ balance: -50, percentUsed: null, state: 'over' });
  });
});

describe('normaliseBudgetAmount', () => {
  it('null and \'\' mean no budget', () => {
    expect(normaliseBudgetAmount(null)).toBeNull();
    expect(normaliseBudgetAmount('')).toBeNull();
  });

  it('accepts zero, a positive amount and the largest amount below MAX_BUDGET', () => {
    expect(normaliseBudgetAmount(0)).toBe(0);
    expect(normaliseBudgetAmount(25000.5)).toBe(25000.5);
    expect(MAX_BUDGET).toBe(1e13);
    expect(normaliseBudgetAmount(9999999999999.99)).toBe(9999999999999.99);
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY, 1e13, 1e16, '5000', [5000], {}, true, undefined])(
    'refuses %s with a typed JobBudgetInvalidError', (v) => {
      expect(() => normaliseBudgetAmount(v)).toThrow(JobBudgetInvalidError);
      expect(() => normaliseBudgetAmount(v)).toThrow(/Engagement budget must be an amount/);
    },
  );
});
