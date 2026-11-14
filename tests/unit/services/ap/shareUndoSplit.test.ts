/**
 * The pro-rata split of an undo-share amount over a bill's posting legs (step 6). Whole cents only; the legs sum to
 * the amount exactly; the remainder lands on the LARGEST non-VAT leg so the VAT leg is the rounded pro-rata figure.
 */
import { describe, expect, it } from 'vitest';
import { splitOverLegs } from '@/modules/accounting/services/ap/shareUndoSplit';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('splitOverLegs', () => {
  it('a full settlement mirrors the legs exactly', () => {
    // JE-2026-29195: 7,990.00 = expense 6,947.83 + VAT 1,042.17.
    expect(splitOverLegs(799000, [{ cents: 694783, isVat: false }, { cents: 104217, isVat: true }]))
      .toEqual([694783, 104217]);
  });

  it('a part settlement splits pro rata and reconciles to the cent, remainder on the largest expense leg', () => {
    const legs = [{ cents: 3333, isVat: false }, { cents: 10000, isVat: false }, { cents: 2000, isVat: true }];
    const out = splitOverLegs(10001, legs);
    expect(sum(out)).toBe(10001);
    // VAT: 10001 * 2000 / 15333 = 1304.51 -> 1305; small leg: 2173.97 -> 2174; remainder 6522 on the 10000 leg.
    expect(out).toEqual([2174, 6522, 1305]);
  });

  it('rounds half up and leaves the rest on the largest leg — not floor, not largest-remainder', () => {
    // 5c over 3/3/4: exact 1.5/1.5/2. Half-up gives 2/2 and the 4c leg takes 1; floor would give 1/1/3 and
    // largest-remainder 2/1/2 (or 1/2/2). Only this rule gives [2, 2, 1].
    expect(splitOverLegs(5, [3, 3, 4].map((c) => ({ cents: c, isVat: false })))).toEqual([2, 2, 1]);
  });

  it('never drives a leg negative when rounding up overshoots (many tiny legs)', () => {
    const legs = [1, 1, 1, 1].map((cents) => ({ cents, isVat: false }));
    const out = splitOverLegs(2, legs);
    expect(sum(out)).toBe(2);
    expect(out.every((c) => c >= 0)).toBe(true);
  });

  it('puts the remainder on the VAT leg only when the bill has no other leg', () => {
    expect(splitOverLegs(150, [{ cents: 300, isVat: true }])).toEqual([150]);
  });

  it('refuses an amount above the legs and a non-positive base', () => {
    expect(() => splitOverLegs(101, [{ cents: 100, isVat: false }])).toThrow(/more than/);
    expect(() => splitOverLegs(1, [])).toThrow();
    expect(() => splitOverLegs(1, [{ cents: 0, isVat: false }])).toThrow();
  });
});
