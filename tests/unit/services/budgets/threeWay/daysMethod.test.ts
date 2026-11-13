/**
 * T2 days method (spec §5): closing = Σ flow × clamp((days − Σ later days) / d, 0, 1),
 * walking back into the lookback; one rounding, half away from zero. F1/F2 closings.
 */
import { describe, it, expect } from 'vitest';
import {
  closingFromDays, derivedDays, walksPastStart,
} from '@/modules/accounting/services/budgets/threeWay/daysMethod';
import { R } from './helpers';

describe('closingFromDays', () => {
  it('F1: D = 15 on 31 000 / 30 000 / 31 000 closes 15 000 each month', () => {
    const flows = [R(31000), R(30000), R(31000)];
    const days = [31, 30, 31];
    expect([0, 1, 2].map(m => closingFromDays(15, flows, days, m))).toEqual([R(15000), R(15000), R(15000)]);
  });

  it('F2: D = 45 walks into the Feb lookback (28 d): Mar 45 000, Apr 45 000', () => {
    const flows = [R(28000), R(31000), R(30000)]; // Feb (lookback), Mar, Apr
    const days = [28, 31, 30];
    expect(closingFromDays(45, flows, days, 1)).toBe(R(45000));
    expect(closingFromDays(45, flows, days, 2)).toBe(R(45000));
  });

  it('days > 2 months walk two months back (Mar + Feb + 11/31 of Jan)', () => {
    const flows = [R(31000), R(28000), R(31000)]; // Jan, Feb, Mar
    expect(closingFromDays(70, flows, [31, 28, 31], 2)).toBe(R(70000));
    expect(walksPastStart(70, [31, 28, 31], 2)).toBe(false);
    expect(walksPastStart(91, [31, 28, 31], 2)).toBe(true);
  });

  it('D = 0 closes 0; D past every month reads missing months as 0', () => {
    expect(closingFromDays(0, [R(100)], [31], 0)).toBe(0);
    expect(closingFromDays(365, [R(100), R(200)], [31, 30], 1)).toBe(R(300));
  });

  it('rounds the one partial month half away from zero, sign kept', () => {
    // 1 cent × 15/30 = 0.5 → 1; −1 cent → −1
    expect(closingFromDays(15, [1], [30], 0)).toBe(1);
    expect(closingFromDays(15, [-1], [30], 0)).toBe(-1);
    // fractional days: 10.5 of 30 on 3000 cents = 1050
    expect(closingFromDays(10.5, [3000], [30], 0)).toBe(1050);
  });
});

describe('derivedDays', () => {
  it('balance ÷ trailing flows × trailing days, 2 dp; null without flows', () => {
    expect(derivedDays(R(51750), [R(1150 * 365)], [365])).toBe(45);
    expect(derivedDays(R(100), [R(300)], [31])).toBe(10.33);
    expect(derivedDays(R(100), [0], [31])).toBeNull();
  });
});
