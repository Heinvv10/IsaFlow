/**
 * decimalSum.ts — decimal-accurate money arithmetic.
 *
 * The reproduction case this guards: `let running = 0; running += debit -
 * credit` in plain JS float across a long alternating sequence produces
 * payload values like 126629.94999999995 for a running balance, and
 * -4.3655745685100555e-11 for a line that should net to exactly 0.
 */
import { describe, it, expect } from 'vitest';
import { toMoney, RunningBalance } from '@/lib/money/decimalSum';

describe('toMoney', () => {
  it('0.1 + 0.2 rounds to exactly 0.3, not 0.30000000000000004', () => {
    expect(toMoney(0.1 + 0.2)).toBe(0.3);
  });

  it('normalises -0 to 0', () => {
    expect(Object.is(toMoney(-0), -0)).toBe(false);
    expect(toMoney(-0)).toBe(0);
    expect(toMoney(-4.3655745685100555e-11)).toBe(0);
  });

  it('reproduces the 126629.95 case exactly', () => {
    // 126629.94999999995 is what plain-float running balances produced.
    expect(toMoney(126629.94999999995)).toBe(126629.95);
  });

  it('rounds a non-tie down or up as expected, regardless of tie mode', () => {
    expect(toMoney(1.004)).toBe(1);
  });

  // ROUND_HALF_CEIL vs ROUND_HALF_UP only disagree on a NEGATIVE tie: HALF_UP
  // rounds away from zero (-1.005 -> -1.01), HALF_CEIL rounds toward +Infinity
  // (-1.005 -> -1), which is what Math.round does — the mode this module must
  // match to stay one report family with gl/trialBalanceBasis.ts and
  // gl/generalLedgerStreamTypes.ts's `round2` helpers.
  it('rounds a negative tie toward +Infinity (HALF_CEIL), matching Math.round — not HALF_UP', () => {
    expect(toMoney(-1.005)).toBe(-1);
  });

  it('rounds a positive tie the same way HALF_UP would (away from zero = toward +Infinity)', () => {
    expect(toMoney(1.005)).toBe(1.01);
  });
});

describe('RunningBalance', () => {
  it('a long alternating sequence that nets to zero returns exactly 0', () => {
    const rb = new RunningBalance(0);
    // 1000 alternating debit/credit pairs of 0.1 each — plain float drifts
    // measurably over this many additions.
    for (let i = 0; i < 1000; i++) {
      rb.add(0.1);
      rb.subtract(0.1);
    }
    expect(rb.value()).toBe(0);
  });

  it('accumulates a realistic debit/credit sequence to the cent', () => {
    const rb = new RunningBalance(0);
    rb.add(126629.95);
    rb.subtract(100000);
    rb.add(0.05);
    expect(rb.value()).toBe(26630);
  });

  it('starts from a non-zero opening balance', () => {
    const rb = new RunningBalance(1500);
    rb.add(1000);
    expect(rb.value()).toBe(2500);
  });

  it('add/subtract return the running value at that point', () => {
    const rb = new RunningBalance(0);
    expect(rb.add(10)).toBe(10);
    expect(rb.subtract(4)).toBe(6);
  });
});
