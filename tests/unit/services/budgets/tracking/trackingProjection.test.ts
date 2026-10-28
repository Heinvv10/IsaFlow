/**
 * Budgets P3 §2.3: Projected FY = actuals to the last COMPLETE month (the
 * in-progress or a future month uses its budget, never part-month actuals)
 * plus budget for every FY* month after the cutoff. FY budget is every month
 * of FY*, 14 in a 14-month year. Pure: the cutoff, the plan, and the line
 * figures buildTrackingLines makes from them.
 */
import { describe, expect, it } from 'vitest';
import {
  projectionCutoff,
  projectionPlan,
} from '@/modules/accounting/services/budgets/tracking/trackingProjection';
import {
  buildTrackingLines,
  type AccountMeta,
  type ActualCell,
  type ClassifiedBudgetCell,
} from '@/modules/accounting/services/budgets/tracking/trackingLines';

const FY2026 = { fiscalYear: 2026, startDate: '2025-03-01', endDate: '2026-02-28' };
const FY2027 = { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' };
const FY2028 = { fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29' };
const FY14 = { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-04-30' };
const TODAY = '2026-10-26';

const months = (from: string, n: number): string[] => {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
};

const RENT: AccountMeta = { accountId: 'rent', accountCode: '6000', accountName: 'Rent', accountType: 'expense', accountSubtype: null };
const SALES: AccountMeta = { accountId: 'sales', accountCode: '4000', accountName: 'Sales', accountType: 'revenue', accountSubtype: null };
const ACCOUNTS = new Map([[RENT.accountId, RENT], [SALES.accountId, SALES]]);

const actual = (accountId: string, month: string, amount: number): ActualCell => ({ accountId, month, amount });
const budget = (accountId: string, month: string, amount: number): ClassifiedBudgetCell => ({ accountId, month, amount, cls: 'included' });

describe('the cutoff', () => {
  it('a window reaching the in-progress month cuts at the end of the month before it', () => {
    expect(projectionCutoff('2026-10-31', TODAY, FY2027)).toBe('2026-09-30');
    expect(projectionCutoff('2027-02-28', TODAY, FY2027)).toBe('2026-09-30');
  });

  it('a window wholly past cuts at its own end', () => {
    expect(projectionCutoff('2026-06-30', TODAY, FY2027)).toBe('2026-06-30');
  });

  it('is clamped to [FY start - 1 day, FY end]', () => {
    expect(projectionCutoff('2028-02-29', TODAY, FY2028)).toBe('2027-02-28');
    expect(projectionCutoff('2026-02-28', TODAY, FY2026)).toBe('2026-02-28');
  });

  it('splits FY* into actual months and budget months at the cutoff', () => {
    const plan = projectionPlan(FY2027, '2026-10-31', TODAY);
    expect(plan.actualMonths).toEqual(months('2026-03', 7));
    expect(plan.budgetMonths).toEqual(months('2026-10', 5));
    expect(plan.fyMonths).toEqual(months('2026-03', 12));
    expect(plan.cutoff).toBe('2026-09-30');
  });
});

/** Rent: 100 actual a complete month, 40 so far in October; budget 120 a month all year. */
function rentYear(fy: { startDate: string }, n: number) {
  const ms = months(fy.startDate.slice(0, 7), n);
  const actuals = ms.filter((m) => m < '2026-10').map((m) => actual('rent', m, 100));
  actuals.push(actual('rent', '2026-10', 40));
  return { actuals, budgets: ms.map((m) => budget('rent', m, 120)) };
}

describe('Projected FY on a line', () => {
  it('= FY-to-date actual through the cutoff + budget strictly after the cutoff month', () => {
    const plan = projectionPlan(FY2027, '2026-10-31', TODAY);
    const { actuals, budgets } = rentYear(FY2027, 12);
    const [line] = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: ['2026-10'], plan, actuals, budgets });
    expect(line!.actual).toBe(40);
    expect(line!.budget).toBe(120);
    // 7 complete months of 100 + budget Oct..Feb (5 x 120). October's 40 is NOT used.
    expect(line!.projected).toBe(1300);
    expect(line!.fyBudget).toBe(1440);
    expect(line!.projVariance).toBe(-140);
    expect(line!.projFavourable).toBe(true);
  });

  it('a 14-month year sums 14 budget months', () => {
    const plan = projectionPlan(FY14, '2027-04-30', TODAY);
    expect(plan.fyMonths.length).toBe(14);
    const { actuals, budgets } = rentYear(FY14, 14);
    const [line] = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: plan.fyMonths, plan, actuals, budgets });
    expect(line!.fyBudget).toBe(14 * 120);
    expect(line!.projected).toBe(7 * 100 + 7 * 120);
  });

  it('an unbudgeted account projects its actuals alone; FY budget and variance are absent', () => {
    const plan = projectionPlan(FY2027, '2026-10-31', TODAY);
    const actuals = months('2026-03', 8).map((m) => actual('sales', m, 50));
    const [line] = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: ['2026-10'], plan, actuals, budgets: [] });
    expect([line!.projected, line!.fyBudget, line!.projVariance, line!.projFavourable]).toEqual([350, null, null, null]);
  });

  it('FY* not started: the projection is all budget', () => {
    const plan = projectionPlan(FY2028, '2028-02-29', TODAY);
    expect(plan.actualMonths).toEqual([]);
    const budgets = months('2027-03', 12).map((m) => budget('rent', m, 10));
    const [line] = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: plan.fyMonths, plan, actuals: [], budgets });
    expect([line!.projected, line!.fyBudget, line!.projVariance]).toEqual([120, 120, 0]);
  });

  it('FY* ended: the projection equals the FY actual', () => {
    const plan = projectionPlan(FY2026, '2026-02-28', TODAY);
    expect(plan.budgetMonths).toEqual([]);
    const ms = months('2025-03', 12);
    const [line] = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: ms, plan,
      actuals: ms.map((m) => actual('rent', m, 7)), budgets: ms.map((m) => budget('rent', m, 5)),
    });
    expect([line!.actual, line!.projected, line!.fyBudget, line!.projVariance, line!.projFavourable]).toEqual([84, 84, 60, 24, false]);
  });

  it('F5: a past month of an ENDED year projects as at the window end (the §2.3 formula), not the FY actual', () => {
    // Spec §2.3 says both "cutoff = min(window end, ...)" and "FY* ended: the projection equals the FY actual".
    // For a June window of the ended FY2026 the formula wins: actuals Mar - Jun, budget Jul - Feb.
    const plan = projectionPlan(FY2026, '2025-06-30', TODAY);
    expect(plan.cutoff).toBe('2025-06-30');
    const ms = months('2025-03', 12);
    const [line] = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: ['2025-06'], plan,
      actuals: ms.map((m) => actual('rent', m, 7)), budgets: ms.map((m) => budget('rent', m, 5)),
    });
    expect([line!.actual, line!.projected, line!.fyBudget]).toEqual([7, 4 * 7 + 8 * 5, 60]);
  });

  it('works in cents: no IEEE-754 drift across 14 months of 0.1', () => {
    const plan = projectionPlan(FY14, '2027-04-30', TODAY);
    const ms = plan.fyMonths;
    const [line] = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: ms, plan,
      actuals: [], budgets: ms.map((m) => budget('rent', m, 0.1)),
    });
    expect(line!.fyBudget).toBe(1.4);
    expect(line!.projected).toBe(0.7);
  });
});
