/**
 * The one margin definition. Four services each had their own, disagreeing on
 * rounding and on what a margin means when there is no turnover, so the same
 * period could quote a different gross margin on two screens.
 */
import { describe, it, expect } from 'vitest';
import { marginPct, marginPct2dp } from '@/modules/accounting/services/reports/marginPct';

describe('marginPct', () => {
  it('is the numerator as a percentage of revenue', () => {
    expect(marginPct(3200000, 5000000)).toBeCloseTo(64, 10);
    expect(marginPct(-120000, 5000000)).toBeCloseTo(-2.4, 10);
  });

  it('is null on no revenue, not zero — a margin on no turnover is undefined', () => {
    expect(marginPct(100, 0)).toBeNull();
    // Callers that must keep emitting 0 do it themselves, so this function
    // never has to know which of them wants which.
    expect(marginPct(100, 0) ?? 0).toBe(0);
  });

  it('refuses a non-finite input rather than emitting NaN into a statement', () => {
    expect(marginPct(NaN, 100)).toBeNull();
    expect(marginPct(100, NaN)).toBeNull();
    expect(marginPct(Infinity, 100)).toBeNull();
  });

  it('marginPct2dp rounds to two decimals, the precision the pack prints', () => {
    // 8394848.60 / 13485163.41 = 62.2527…%
    expect(marginPct2dp(8394848.60, 13485163.41)).toBe(62.25);
    expect(marginPct2dp(1, 3)).toBe(33.33);
    expect(marginPct2dp(1, 0)).toBeNull();
  });

  it('agrees with the unrounded definition to within the rounding', () => {
    const n = 8394848.60, r = 13485163.41;
    expect(Math.abs(marginPct2dp(n, r)! - marginPct(n, r)!)).toBeLessThan(0.005);
  });
});
