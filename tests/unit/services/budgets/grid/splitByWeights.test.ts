/**
 * `splitByWeights` (decision 5, unbounded N): a cents total split across N parts, evenly (a count)
 * or by one-signed weights (PY share). Every part but the LAST is rounded half away from zero to the
 * unit, exactly (BigInt); the last takes the residue, so Σ parts = total to the cent. Used for a
 * header's sub-accounts, which can be more than the 15 months the month spreads accept.
 *
 * `residueFlipsSign`: the rounding unit can push the residue month to the other side of zero
 * (R1 800 over 12 months at R100: eleven × R200, last −R400); the grid warns when it does.
 *
 * Mutations (each must turn a case red): residue on the first part; Math.round on floats instead of
 * exact BigInt half-away; residue dropped (Σ ≠ total); unbounded N capped at 15.
 */
import { describe, it, expect } from 'vitest';
import { residueFlipsSign, splitByWeights } from '@/modules/accounting/services/budgets/grid/spread';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

describe('splitByWeights', () => {
  const cases: { name: string; total: number; by: number | number[]; unit: RoundingUnit; want: number[] }[] = [
    { name: 'even, exact', total: 300_00, by: 3, unit: 1, want: [100_00, 100_00, 100_00] },
    { name: 'even, residue last', total: 100_00, by: 3, unit: 1, want: [33_00, 33_00, 34_00] },
    { name: 'even, cents residue', total: 100_01, by: 2, unit: 1, want: [50_00, 50_01] },
    { name: 'even, R100', total: 1000_00, by: 3, unit: 100, want: [300_00, 300_00, 400_00] },
    { name: 'even, R1000, negative', total: -5000_00, by: 4, unit: 1000, want: [-1000_00, -1000_00, -1000_00, -2000_00] },
    { name: 'even, negative half rounds away from zero', total: -300_00, by: 2, unit: 100, want: [-200_00, -100_00] },
    { name: 'even, positive half rounds away from zero', total: 300_00, by: 2, unit: 100, want: [200_00, 100_00] },
    { name: 'even, total under a unit lands on the last', total: 40_00, by: 3, unit: 100, want: [0, 0, 40_00] },
    { name: 'one part takes everything', total: 123_45, by: 1, unit: 1000, want: [123_45] },
    { name: 'weights', total: 900_00, by: [1, 2, 6], unit: 1, want: [100_00, 200_00, 600_00] },
    { name: 'weights, residue last', total: 100_00, by: [1, 1, 1], unit: 1, want: [33_00, 33_00, 34_00] },
    { name: 'negative weights', total: 1000_00, by: [-1, -3], unit: 1, want: [250_00, 750_00] },
    { name: 'a zero weight gets zero', total: 500_00, by: [0, 5, 5], unit: 1, want: [0, 250_00, 250_00] },
    { name: 'zero total', total: 0, by: 4, unit: 1, want: [0, 0, 0, 0] },
  ];
  it.each(cases)('$name', ({ total, by, unit, want }) => {
    const r = splitByWeights(total, by, unit);
    expect(r).toEqual({ ok: true, parts: want });
    if (r.ok) expect(sum(r.parts)).toBe(total);
  });

  it.each([1, 100, 1000] as RoundingUnit[])('R%s: 1 000 parts (far above 15), Σ exact, all but the last a unit multiple', unit => {
    const r = splitByWeights(123_456_78, 1000, unit);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parts).toHaveLength(1000);
    expect(sum(r.parts)).toBe(123_456_78);
    expect(r.parts.slice(0, -1).every(x => x % (unit * 100) === 0)).toBe(true);
  });

  it('exact where floats are not: weights whose product passes 2^53', () => {
    const r = splitByWeights(90_000_000_000_00, [3_000_000_000_00, 6_000_000_000_00], 1);
    expect(r).toEqual({ ok: true, parts: [30_000_000_000_00, 60_000_000_000_00] });
  });

  it.each([
    { name: 'no parts', by: 0 },
    { name: 'a fractional count', by: 2.5 },
    { name: 'an empty weight list', by: [] as number[] },
    { name: 'mixed-sign weights', by: [1, -1] },
    { name: 'all-zero weights', by: [0, 0] },
    { name: 'a fractional weight', by: [1.5, 2] },
  ])('refuses $name with a reason', ({ by }) => {
    expect(splitByWeights(100_00, by, 1)).toMatchObject({ ok: false, reason: expect.any(String) });
  });

  it('refuses a total that is not whole cents', () => {
    expect(splitByWeights(1.5, 2, 1)).toMatchObject({ ok: false });
  });
});

describe('residueFlipsSign', () => {
  it('flags a last month on the other side of zero from the total', () => {
    expect(residueFlipsSign(1800_00, [...Array<number>(11).fill(200_00), -400_00])).toBe(true);
    expect(residueFlipsSign(-1800_00, [...Array<number>(11).fill(-200_00), 400_00])).toBe(true);
  });
  it('a residue with the total\'s sign, or zero, is fine', () => {
    expect(residueFlipsSign(1600_00, [...Array<number>(11).fill(100_00), 500_00])).toBe(false);
    expect(residueFlipsSign(1200_00, [...Array<number>(11).fill(100_00), 100_00])).toBe(false);
    expect(residueFlipsSign(0, [0, 0])).toBe(false);
    expect(residueFlipsSign(100_00, [100_00, 0])).toBe(false);
  });
});
