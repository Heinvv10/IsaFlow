/**
 * compare (§7, §13.22): per version closing cash series, min cash, NP, closing
 * AR/AP, net debt; Δ = version − first; Δ% = Δ / |first| × 100, null when first
 * is 0; favourable separate (cash higher = favourable), null when Δ = 0 (fix round 1, item 14).
 */
import { describe, it, expect } from 'vitest';
import { compareVersions } from '@/modules/accounting/services/budgets/threeWay/compare';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { CompareInputError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { assumptions, buckets, input, monthsFrom, pnl, R } from './helpers';

const months = monthsFrom('2026-03', 3);
const run = (debtorDays: number, first = '2026-03') => {
  const ms = monthsFrom(first, 3);
  return runThreeWay(input({
    months: ms, pnl: ms.map(() => pnl({ turnover: 31000, otherOpex: 10000 })),
    opening: buckets({ cash: 1000, loans: -5000, otherEquity: 4000 }),
    assumptions: assumptions(ms, { debtorDays }),
  }));
};

describe('compareVersions', () => {
  const base = run(0); const worst = run(31);
  const res = compareVersions([{ versionId: 'b', name: 'Base', output: base }, { versionId: 'w', name: 'Worst', output: worst }]);
  it('series and Δ cash per month vs the first', () => {
    expect(res.months).toEqual(months);
    expect(res.versions[0]?.cashSeries).toEqual([R(22000), R(43000), R(64000)]);
    expect(res.versions[1]?.cashSeries).toEqual([-R(9000), R(11000), R(33000)]);
    expect(res.versions[1]?.cashDelta).toEqual([-R(31000), -R(32000), -R(31000)]);
    expect(res.versions[0]?.cashDelta).toEqual([0, 0, 0]);
  });
  it('KPIs with Δ, Δ% and favourable', () => {
    const w = res.versions[1]?.kpis;
    expect(w?.closingCash).toEqual({ value: R(33000), delta: -R(31000), deltaPct: -48.4375, favourable: false });
    expect(w?.minCash).toEqual({ value: -R(9000), delta: -R(31000), deltaPct: -140.9090909090909, favourable: false });
    expect(w?.netProfit).toEqual({ value: R(63000), delta: 0, deltaPct: 0, favourable: null });
    expect(w?.closingReceivables).toEqual({ value: R(31000), delta: R(31000), deltaPct: null, favourable: false });
    expect(w?.netDebt).toEqual({ value: -R(28000), delta: R(31000), deltaPct: 52.54237288135594, favourable: false });
    expect(res.versions[1]?.minCashMonth).toBe('2026-03');
    expect(res.versions[0]?.kpis.closingCash).toEqual({ value: R(64000), delta: 0, deltaPct: 0, favourable: null });
  });
  it('refuses 0 or 4 versions and mismatched months', () => {
    expect(() => compareVersions([])).toThrow(CompareInputError);
    const e = { versionId: 'x', name: 'x', output: base };
    expect(() => compareVersions([e, e, e, e])).toThrow(CompareInputError);
    expect(() => compareVersions([e, { versionId: 'y', name: 'y', output: run(0, '2026-04') }])).toThrow(CompareInputError);
  });
});
