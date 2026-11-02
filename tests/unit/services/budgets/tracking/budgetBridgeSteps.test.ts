/**
 * Budgets P3 §2.7: the profit bridge from budget NP to actual NP. Each band's
 * step is its EFFECT ON PROFIT (income +Δ, expense −Δ), labelled with the
 * ledger-signed Δ (`WaterfallStep.labelValue`); the steps foot exactly; the
 * bar colour is `varianceColor`'s (through the existing waterfall builder).
 */
import { describe, expect, it } from 'vitest';
import { budgetBridgeSteps } from '@/modules/accounting/services/budgets/tracking/budgetBridgeSteps';
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { buildTrackingLines, type AccountMeta } from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';
import { makeWaterfallRenderItem } from '@/components/accounting/charts/waterfallOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts';

const M = '2026-06';
const meta = (accountId: string, accountType: 'revenue' | 'expense', accountSubtype: string | null): AccountMeta =>
  ({ accountId, accountCode: accountId, accountName: accountId, accountType, accountSubtype });
const ACCOUNTS = new Map<string, AccountMeta>([
  ['sales', meta('sales', 'revenue', null)], ['interest', meta('interest', 'revenue', 'other_income')],
  ['cos', meta('cos', 'expense', 'cost_of_sales')], ['rent', meta('rent', 'expense', null)], ['fin', meta('fin', 'expense', 'finance_cost')],
]);
const PLAN = projectionPlan({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' }, '2026-06-30', '2026-10-26');

function reportOf(actual: Record<string, number>, budget: Record<string, number>) {
  const lines = buildTrackingLines({
    accounts: ACCOUNTS, windowMonths: [M], plan: PLAN,
    actuals: Object.entries(actual).map(([accountId, amount]) => ({ accountId, month: M, amount })),
    budgets: Object.entries(budget).map(([accountId, amount]) => ({ accountId, month: M, amount, cls: 'included' as const })),
  });
  return { bands: buildBands(lines) };
}

// Sales 1000.10 vs 900.05; interest 0.30 vs 0.10 (a band with no budget would make the profit totals, and so the bridge, null: final R9); COS 300.20 vs 400; rent 200.07 vs 150.01; finance 20 vs 20.
const REPORT = reportOf(
  { sales: 1000.1, interest: 0.3, cos: 300.2, rent: 200.07, fin: 20 },
  { sales: 900.05, interest: 0.1, cos: 400, rent: 150.01, fin: 20 },
);
const npOf = (k: 'actual' | 'budget') => REPORT.bands.find((b) => b.key === 'net_profit')![k]!;

describe('budgetBridgeSteps', () => {
  const steps = budgetBridgeSteps(REPORT);

  it('runs budget NP → five band effects → actual NP', () => {
    expect(steps.map((s) => s.label)).toEqual([
      'Budget net profit', 'Turnover', 'Cost of Sales', 'Other Income', 'Operating Expenses', 'Other Expenses', 'Actual net profit',
    ]);
    expect([steps[0]!.isSubtotal, steps[0]!.start, steps[0]!.end]).toEqual([true, 0, npOf('budget')]);
    expect([steps[6]!.isSubtotal, steps[6]!.start, steps[6]!.end]).toEqual([true, 0, npOf('actual')]);
  });

  it('foots exactly: budget NP + Σ effects = actual NP, in cents', () => {
    const effects = steps.slice(1, 6).reduce((s, x) => s + Math.round(x.value * 100), 0);
    expect(Math.round(npOf('budget') * 100) + effects).toBe(Math.round(npOf('actual') * 100));
    for (let i = 1; i < 6; i++) {
      expect(steps[i]!.start, `step ${i} starts where ${i - 1} ended`).toBe(i === 1 ? npOf('budget') : steps[i - 1]!.end);
      expect(Math.round((steps[i]!.end - steps[i]!.start) * 100)).toBe(Math.round(steps[i]!.value * 100));
    }
    expect(steps[5]!.end).toBe(npOf('actual'));
  });

  it('an expense step is the NEGATED Δ, labelled with the ledger Δ; an income step is +Δ', () => {
    const by = (label: string) => steps.find((s) => s.label === label)!;
    expect([by('Turnover').value, by('Turnover').labelValue]).toEqual([100.05, undefined]);
    expect([by('Other Income').value, by('Other Income').labelValue]).toEqual([0.2, undefined]);
    expect([by('Cost of Sales').value, by('Cost of Sales').labelValue]).toEqual([99.8, -99.8]);
    expect([by('Operating Expenses').value, by('Operating Expenses').labelValue]).toEqual([-50.06, 50.06]);
  });

  it('colours each bar through varianceColor: overspend unfavourable, beat favourable', () => {
    const render = makeWaterfallRenderItem(steps, DEFAULT_PALETTE);
    const api = {
      coord: ([, v]: number[]) => [0, -(v ?? 0)],
      size: () => [20, 0],
      getWidth: () => 1280,
    } as unknown as CustomSeriesRenderItemAPI;
    const fill = (i: number) => {
      const out = render({ dataIndex: i } as CustomSeriesRenderItemParams, api) as unknown as { children: Array<{ style: { fill: string } }> };
      return out.children[0]!.style.fill;
    };
    const idx = (label: string) => steps.findIndex((s) => s.label === label);
    expect(fill(idx('Turnover'))).toBe(DEFAULT_PALETTE.fav);
    expect(fill(idx('Cost of Sales'))).toBe(DEFAULT_PALETTE.fav);
    expect(fill(idx('Operating Expenses'))).toBe(DEFAULT_PALETTE.unfav);
  });

  it('no budget: no bridge, rather than one from a zero budget', () => {
    expect(budgetBridgeSteps(reportOf({ sales: 10 }, {}))).toEqual([]);
  });
});
