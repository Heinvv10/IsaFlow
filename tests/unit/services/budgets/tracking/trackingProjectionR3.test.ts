/**
 * Budgets P3 PR-B review r3 (ledger breaker and verifier), adopted as tests:
 * - M1: the heatmap judges a month only once it is complete. On a window that runs from the month
 *   in progress into a FUTURE FY*, the projection cutoff is clamped up to FY*.start - 1, so the
 *   cutoff's month cannot say what is judged: `plan.judgedThrough` = min(cutoff month, the month
 *   before today's).
 * - L1: a budgeted ZERO is a budget row: after the cutoff it takes its 0, not the month's actual
 *   (a forward-dated posting against it then leaves Projected FY below the actual, the spec's
 *   formula for a budgeted line).
 * - Properties (200 random lines per year shape, deterministic PRNG): with no budget row after the
 *   cutoff, Projected FY is the FY* actual exactly; band and NP projections are sums of lines.
 */
import { describe, expect, it } from 'vitest';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';
import { buildTrackingLines, type AccountMeta, type ActualCell, type ClassifiedBudgetCell } from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { heatmapSummary } from '@/components/accounting/budgets/tracking/trackingChartSummaries';
import { buildVarianceHeatmapOption } from '@/components/accounting/charts/varianceHeatmapOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import { budgetMonthKeysInWindow } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import type { TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const FY2027 = { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' };
const FY2028 = { fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29' };
const FY14 = { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-04-30' };
const TODAY = '2026-10-29';
const meta = (id: string, type: 'revenue' | 'expense', subtype: string | null = null): AccountMeta =>
  ({ accountId: id, accountCode: id, accountName: id, accountType: type, accountSubtype: subtype });
const A = (accountId: string, month: string, amount: number): ActualCell => ({ accountId, month, amount });
const B = (accountId: string, month: string, amount: number): ClassifiedBudgetCell => ({ accountId, month, amount, cls: 'included' });

// Deterministic PRNG.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

describe('C: heatmap judges only complete months', () => {
  it('REPRO: a cross-year window from the month in progress into a FUTURE FY judges the in-progress month and later', () => {
    // Custom 2026-09..2027-04 on 2026-10-29: FY* = FY2028 (holds the window end), not started.
    const plan = projectionPlan(FY2028, '2027-04-30', TODAY);
    const judgedThrough = plan.judgedThrough; // what BudgetTrackingVisuals passes
    const months = budgetMonthKeysInWindow('2026-09-01', '2027-04-01');
    const line = {
      accountId: 'x', accountCode: '6000', accountName: 'Rent', accountType: 'expense', band: 'operating_expense',
      actual: 0, budget: 0, variance: 0, variancePct: null, favourable: null, projected: 0, fyBudget: null, projVariance: null,
      projFavourable: null, unallocatedBudget: 0, budgetAboveFilter: false, partialBudget: false,
      monthly: months.map((m) => ({ month: m, actual: m === '2026-10' ? 10 : 0, budget: 1000, variance: (m === '2026-10' ? 10 : 0) - 1000, favourable: true, budgetAboveFilter: false })),
    } as TrackingLine;
    const option = buildVarianceHeatmapOption([line], months, DEFAULT_PALETTE, { judgedThrough }) as { xAxis: { data: string[] } };
    const summary = heatmapSummary([line], months, judgedThrough);
    // Oct 2026 is in progress; Nov 2026 .. Apr 2027 are still to come: none is a full miss yet.
    expect(judgedThrough <= '2026-09').toBe(true);
    expect(option.xAxis.data.filter((l) => l.endsWith('*')).length).toBe(7);
    expect(summary).toMatch(/not yet judged/);
  });

  it('judgedThrough is min(cutoff month, the month before today): same-year, past, and a future FY*', () => {
    expect(projectionPlan(FY2027, '2027-02-28', TODAY).judgedThrough).toBe('2026-09');
    expect(projectionPlan(FY2027, '2026-06-30', TODAY).judgedThrough).toBe('2026-06');
    expect(projectionPlan(FY2028, '2028-02-29', TODAY).cutoff).toBe('2027-02-28');
    expect(projectionPlan(FY2028, '2028-02-29', TODAY).judgedThrough).toBe('2026-09');
  });
});

describe('ledger properties and the budgeted zero', () => {
  it('zero budget on a later month with a forward-dated actual: projected uses the 0 (ruling), so projected < FY actual by that actual', () => {
    const plan = projectionPlan(FY2027, '2027-02-28', TODAY);
    const lines = buildTrackingLines({
      accounts: new Map([['r', meta('r', 'expense')]]), windowMonths: plan.fyMonths, plan,
      actuals: [A('r', '2026-04', 100), A('r', '2027-01', 500)],
      budgets: plan.fyMonths.map((m) => B('r', m, m === '2027-01' ? 0 : 100)),
    });
    expect(lines[0]!.actual).toBe(600);
    expect(lines[0]!.projected).toBe(500); // 100 (Apr) + Oct..Feb budgets 100+100+100+0+100; the 500 Jan posting is replaced by the 0 budget
  });

  it('property: with no budget row in any month after the cutoff, projected == FY* actual exactly (any mix, 14-month, past, future FY)', () => {
    for (const [fy, windowEnd] of [[FY2027, '2027-02-28'], [FY14, '2027-04-30'], [FY2028, '2028-02-29'], [{ fiscalYear: 2026, startDate: '2025-03-01', endDate: '2026-02-28' }, '2026-02-28']] as const) {
      const plan = projectionPlan(fy, windowEnd, TODAY);
      for (let t = 0; t < 200; t++) {
        const actuals: ActualCell[] = []; const budgets: ClassifiedBudgetCell[] = [];
        for (const m of plan.fyMonths) {
          if (rnd() < 0.7) actuals.push(A('r', m, Math.round((rnd() - 0.3) * 100000) / 100));
          if (plan.actualMonths.includes(m) && rnd() < 0.5) budgets.push(B('r', m, Math.round(rnd() * 100000) / 100));
        }
        if (actuals.length === 0) continue;
        const [l] = buildTrackingLines({ accounts: new Map([['r', meta('r', 'expense')]]), windowMonths: plan.fyMonths, plan, actuals, budgets });
        const fyActual = actuals.reduce((s, a) => s + Math.round(a.amount * 100), 0) / 100;
        expect(l!.projected).toBeCloseTo(fyActual, 2);
        expect(l!.actual).toBeCloseTo(fyActual, 2);
      }
    }
  });

  it('property: band and NP projections are sums of line projections (mixed partial/unbudgeted/budgeted)', () => {
    const plan = projectionPlan(FY2027, '2026-12-31', TODAY);
    const ids = ['s1', 's2', 'c1', 'o1', 'e1', 'e2', 'x1'];
    const accts = new Map<string, AccountMeta>([
      ['s1', meta('s1', 'revenue')], ['s2', meta('s2', 'revenue')], ['c1', meta('c1', 'expense', 'cost_of_sales')],
      ['o1', meta('o1', 'revenue', 'other_income')], ['e1', meta('e1', 'expense')], ['e2', meta('e2', 'expense')], ['x1', meta('x1', 'expense', 'other_expense')],
    ]);
    for (let t = 0; t < 100; t++) {
      const actuals: ActualCell[] = []; const budgets: ClassifiedBudgetCell[] = [];
      for (const id of ids) for (const m of plan.fyMonths) {
        if (rnd() < 0.6) actuals.push(A(id, m, Math.round(rnd() * 1e6) / 100));
        if (rnd() < 0.4) budgets.push(B(id, m, Math.round(rnd() * 1e6) / 100));
      }
      const lines = buildTrackingLines({ accounts: accts, windowMonths: budgetMonthKeysInWindow('2026-10-01', '2026-12-01'), plan, actuals, budgets });
      const bands = buildBands(lines);
      const sum = (pred: (l: TrackingLine) => boolean) => Math.round(lines.filter(pred).reduce((s, l) => s + l.projected * 100, 0)) / 100;
      const inc = sum((l) => l.accountType === 'revenue'); const exp = sum((l) => l.accountType === 'expense');
      expect(bands.find((b) => b.key === 'net_profit')!.projected).toBeCloseTo(inc - exp, 2);
      for (const b of bands.filter((x) => x.kind === 'band')) expect(b.projected).toBeCloseTo(sum((l) => l.band === b.key), 2);
    }
  });
});
