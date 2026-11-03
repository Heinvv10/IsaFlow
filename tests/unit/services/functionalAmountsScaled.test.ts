/** PR S round eight: toScaledInteger / sameCents on negatives, half away from zero as numeric ROUND() does. */
import { describe, expect, it } from 'vitest';
import { sameCents, toScaledInteger } from '@/modules/accounting/services/shared/functionalAmounts';

describe('toScaledInteger and sameCents, negatives', () => {
  it("'-1.005' is -101 cents (away from zero, not toward it)", () => { expect(toScaledInteger('-1.005', 2)).toBe(-101n); });
  it("'-0.004' is 0 cents", () => { expect(toScaledInteger('-0.004', 2)).toBe(0n); });
  it('-1.005 and -1.01 are the same to the cent', () => { expect(sameCents('-1.005', -1.01)).toBe(true); });
  it('1.005 is 101 cents; a non-decimal is null and never the same', () => {
    expect(toScaledInteger(1.005, 2)).toBe(101n);
    expect(toScaledInteger('abc', 2)).toBeNull();
    expect(sameCents('abc', 0)).toBe(false);
  });
});
