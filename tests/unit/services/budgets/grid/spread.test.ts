/**
 * Spreads and uplift (decision 5): every result sums to its target to the cent,
 * every month but the last is a multiple of the rounding unit, and the residue
 * lands on the LAST month only.
 */
import { describe, it, expect } from 'vitest';
import { spreadEven, spreadSeasonal, spreadStep, uplift } from '@/modules/accounting/services/budgets/grid/spread';
import { roundToUnit, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';

const UNITS: RoundingUnit[] = [1, 100, 1000];
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

function months(r: ReturnType<typeof spreadEven>): number[] {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.months;
}

function expectUnitShape(ms: number[], target: number, unit: RoundingUnit) {
  expect(sum(ms)).toBe(target);
  for (const m of ms.slice(0, -1)) expect(Math.abs(m) % (unit * 100)).toBe(0);
  for (const m of ms) expect(Number.isInteger(m)).toBe(true);
}

const PY = [100000, 120000, 90000, 110000, 105000, 95000, 130000, 125000, 80000, 70000, 140000, 150050];

describe('spreadEven', () => {
  it.each(UNITS)('R%s: sums to the total, residue on the last month', unit => {
    const ms = months(spreadEven(1234567, 12, unit));
    expectUnitShape(ms, 1234567, unit);
    expect(new Set(ms.slice(0, -1)).size).toBe(1);
  });

  it('puts the residue on the last month, not the first', () => {
    const ms = months(spreadEven(1000000, 12, 1)); // R10 000 / 12 = R833.33
    expect(ms.slice(0, 11)).toEqual(Array<number>(11).fill(83300));
    expect(ms[11]).toBe(1000000 - 11 * 83300);
  });

  it('spreads over the longest (15-month) year', () => {
    expectUnitShape(months(spreadEven(1500000, 15, 1)), 1500000, 1);
    expect(months(spreadEven(1500000, 15, 1))).toHaveLength(15);
  });

  it('never returns negative zero', () => {
    expect(Object.is(months(spreadEven(-0, 2, 1))[1], 0)).toBe(true);
  });

  it('spreads a negative total and a 14-month year', () => {
    expectUnitShape(months(spreadEven(-1234567, 14, 100)), -1234567, 100);
    expect(months(spreadEven(-1200000, 12, 1))).toEqual(Array<number>(12).fill(-100000));
  });

  it('rounds the monthly share half away from zero', () => {
    // R30 over 12 = R2.50 a month → R3 at R1 (half-even would give R2)
    expect(months(spreadEven(3000, 12, 1)).slice(0, 11)).toEqual(Array<number>(11).fill(300));
  });

  it('refuses a bad month count or fractional cents', () => {
    expect(spreadEven(100, 0, 1).ok).toBe(false);
    expect(spreadEven(100, 16, 1).ok).toBe(false);
    expect(spreadEven(100.5, 12, 1).ok).toBe(false);
  });
});

describe('spreadSeasonal', () => {
  it.each(UNITS)('R%s: follows the PY shape and sums to the total', unit => {
    const ms = months(spreadSeasonal(5000000, PY, unit));
    expectUnitShape(ms, 5000000, unit);
  });

  it('weights months by the PY share', () => {
    const ms = months(spreadSeasonal(1200000, [100, 200, 300, 600], 1));
    expect(ms).toEqual([100000, 200000, 300000, 600000]);
  });

  it('handles an all-negative PY (credits) as a shape', () => {
    const ms = months(spreadSeasonal(400000, [-100, -300], 1));
    expect(ms).toEqual([100000, 300000]);
  });

  it('refuses a PY that sums to zero, with a reason', () => {
    const r = spreadSeasonal(100000, [0, 0, 0], 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no prior-year/i);
  });

  it('refuses a mixed-sign PY, with a reason', () => {
    const r = spreadSeasonal(100000, [500, -100, 300], 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mixed signs/i);
  });

  it('does not overflow on large totals × large PY months', () => {
    const big = Array<number>(12).fill(99999999999999);
    expectUnitShape(months(spreadSeasonal(999999999999999, big, 1000)), 999999999999999, 1000);
  });
});

describe('spreadStep', () => {
  it.each(UNITS)('R%s: grows month on month and sums to the total', unit => {
    const ms = months(spreadStep(6000000, 12, 5, unit));
    expectUnitShape(ms, 6000000, unit);
    if (unit === 1) for (let i = 1; i < 11; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]);
  });

  it('0% growth is the even spread', () => {
    expect(months(spreadStep(1234567, 12, 0, 100))).toEqual(months(spreadEven(1234567, 12, 100)));
  });

  it('weights month i by (1 + g)^i exactly', () => {
    // R331 at 10%: weights 1, 1.1, 1.21 (Σ 3.31) → R100, R110, R121
    expect(months(spreadStep(33100, 3, 10, 1))).toEqual([10000, 11000, 12100]);
  });

  it('rounds each share half away from zero', () => {
    // R4.50 at 100%: weights 1, 2 → R1.50 → R2, residue R2.50 on the last month
    expect(months(spreadStep(450, 2, 100, 1))).toEqual([200, 250]);
  });

  it('refuses growth at or below -100%, above 1000%, or not a number', () => {
    expect(spreadStep(100000, 12, -100, 1).ok).toBe(false);
    expect(spreadStep(100000, 12, 1000.01, 1).ok).toBe(false);
    expect(spreadStep(100000, 12, 1e300, 1).ok).toBe(false);
    expect(spreadStep(100000, 12, Number.NaN, 1).ok).toBe(false);
    expect(spreadStep(100000, 15, 1000, 1).ok).toBe(true);
  });
});

describe('uplift', () => {
  it.each(UNITS)('R%s: target = roundToUnit(ΣPY × 1.1), residue on the last month', unit => {
    const ms = months(uplift(PY, 10, unit));
    const target = roundToUnit(Math.round(sum(PY) * 11 / 10), unit);
    expectUnitShape(ms, target, unit);
  });

  it('rounds each month on the exact decimal, not the float product', () => {
    // R30 × 1.15 = R34.50 exactly → R35 at R1; the float product is 34.4999… and would round to R34
    const ms = months(uplift([3000, 3000, 3000], 15, 1));
    expect(ms[0]).toBe(3500);
    expect(ms[1]).toBe(3500);
    expect(sum(ms)).toBe(roundToUnit(10350, 1));
  });

  it('keeps negative PY months negative', () => {
    const ms = months(uplift([100000, -20000, 50000], 10, 1));
    expect(ms[1]).toBe(-22000);
    expect(sum(ms)).toBe(143000);
  });

  it('refuses a result beyond NUMERIC(15,2) instead of returning lost-precision cents', () => {
    const r = uplift(Array<number>(12).fill(100000000000000), 1000, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/larger than/i);
    expect(uplift([9e15], 10, 1).ok).toBe(false);
    // The target (0) fits; each uplifted month (±11 × the largest amount) does not.
    const most = 999999999999999;
    expect(uplift([most, -most], 1000, 1).ok).toBe(false);
  });

  it('-100% gives zeros; refuses out of range', () => {
    expect(months(uplift(PY, -100, 1000))).toEqual(Array<number>(12).fill(0));
    expect(uplift(PY, -100.01, 1).ok).toBe(false);
    expect(uplift(PY, 1000.01, 1).ok).toBe(false);
    expect(uplift([], 10, 1).ok).toBe(false);
  });
});
