/**
 * Budgets P5-4 (spec §3d, decision 9): the overspend alerts' pure rules. Percentage of budget
 * (actual + committed over budget, a zero budget included), which thresholds apply to a key (most
 * specific override first), which are crossed, and the in-app link.
 */
import { describe, expect, it } from 'vitest';
import {
  alertHref,
  crossingsOf,
  DEFAULT_THRESHOLDS,
  highestPerKey,
  MAX_ALERT_NOTIFICATIONS_PER_RUN,
  normaliseThresholds,
  overspendPct,
  thresholdsFor,
  type AlertKeyFigures,
} from '@/modules/accounting/services/budgets/overspendAlertsCore';
import { isInAppPath } from '@/lib/inAppPath';

const ACC = '11111111-1111-4111-8111-111111111111';
const ACC2 = '22222222-2222-4222-8222-222222222222';
const CC = '33333333-3333-4333-8333-333333333333';
const CC_OTHER = '44444444-4444-4444-8444-444444444444';

const key = (over: Partial<AlertKeyFigures> = {}): AlertKeyFigures => ({
  glAccountId: ACC, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', budget: 1000, actual: 0, committed: 0, ...over,
});

describe('overspendPct', () => {
  it('is (actual + committed) / budget × 100, committed counted', () => {
    expect(overspendPct(1000, 700, 150)).toBe(85);
    expect(overspendPct(1000, 1000, 0)).toBe(100);
    expect(overspendPct(200.5, 100.25, 0)).toBe(50);
  });

  it('a zero (or negative) budget with spend is infinite; with no spend it is 0', () => {
    expect(overspendPct(0, 0.01, 0)).toBe(Infinity);
    expect(overspendPct(0, 0, 5)).toBe(Infinity);
    expect(overspendPct(-10, 1, 0)).toBe(Infinity);
    expect(overspendPct(0, 0, 0)).toBe(0);
    expect(overspendPct(0, -50, 0)).toBe(0);
  });

  it('negative spend (credits) is a negative percentage, never a crossing', () => {
    expect(overspendPct(1000, -100, 0)).toBe(-10);
  });
});

describe('thresholdsFor: the most specific match wins', () => {
  const overrides = [
    { glAccountId: ACC, cc1Id: null, cc2Id: null, buId: null, thresholds: [90] },
    { glAccountId: ACC, cc1Id: CC, cc2Id: null, buId: null, thresholds: [50, 75] },
  ];
  it('slice override, then account override, then the company default, then 80/100/120', () => {
    expect(thresholdsFor(key({ cc1Id: CC }), overrides, [70, 95])).toEqual([50, 75]);
    expect(thresholdsFor(key({ cc1Id: CC_OTHER }), overrides, [70, 95])).toEqual([90]);
    expect(thresholdsFor(key(), overrides, [70, 95])).toEqual([90]);
    expect(thresholdsFor(key({ glAccountId: ACC2 }), overrides, [70, 95])).toEqual([70, 95]);
    expect(thresholdsFor(key({ glAccountId: ACC2 }), overrides, null)).toEqual([...DEFAULT_THRESHOLDS]);
    expect(DEFAULT_THRESHOLDS).toEqual([80, 100, 120]);
  });

  it('matches ids case-insensitively', () => {
    expect(thresholdsFor(key({ glAccountId: ACC.toUpperCase(), cc1Id: CC.toUpperCase() }), overrides, null)).toEqual([50, 75]);
  });
});

describe('crossingsOf', () => {
  const none = () => [80, 100, 120];
  it('every threshold at or below the percentage, one per threshold', () => {
    const out = crossingsOf([key({ actual: 900, committed: 150 })], none);
    expect(out.map((c) => c.threshold)).toEqual([80, 100]);
    expect(out[0]!.pct).toBe(105);
    expect(crossingsOf([key({ actual: 800 })], none).map((c) => c.threshold)).toEqual([80]);
    expect(crossingsOf([key({ actual: 799.99 })], none)).toEqual([]);
  });

  it('a zero budget with spend crosses every threshold; with none, nothing', () => {
    const out = crossingsOf([key({ budget: 0, actual: 1 })], none);
    expect(out.map((c) => c.threshold)).toEqual([80, 100, 120]);
    expect(out.every((c) => c.pct === Infinity)).toBe(true);
    expect(crossingsOf([key({ budget: 0 })], none)).toEqual([]);
  });

  it('a key with no budget (null) never alerts', () => {
    expect(crossingsOf([key({ budget: null, actual: 5000 })], none)).toEqual([]);
  });
});

describe('normaliseThresholds', () => {
  it('sorts ascending and drops duplicates', () => {
    expect(normaliseThresholds([120, 80, 100, 80])).toEqual([80, 100, 120]);
  });
});

describe('alertHref', () => {
  it('opens Budget vs Actual on the month, filtered to the slice, as an in-app path', () => {
    expect(alertHref({ month: '2026-04', cc1Id: null, cc2Id: null, buId: null }))
      .toBe('/accounting/reports/budget-vs-actual?period=month&month=2026-04');
    const h = alertHref({ month: '2026-04', cc1Id: null, cc2Id: CC, buId: null });
    expect(h).toBe(`/accounting/reports/budget-vs-actual?period=month&month=2026-04&cc2_id=${CC}`);
    expect(isInAppPath(h)).toBe(true);
  });
});

describe('highestPerKey', () => {
  it('keeps the highest threshold of each (account, slice, month), in input order', () => {
    const a = (threshold: number, over: Partial<AlertKeyFigures> = {}) => ({ ...key(over), threshold });
    const out = highestPerKey([a(80), a(100), a(80, { cc1Id: CC }), a(120, { month: '2026-05' }), a(100, { month: '2026-05' })]);
    expect(out.map((x) => [x.cc1Id, x.month, x.threshold])).toEqual([[null, '2026-04', 100], [CC, '2026-04', 80], [null, '2026-05', 120]]);
    expect(MAX_ALERT_NOTIFICATIONS_PER_RUN).toBe(10);
  });
});
