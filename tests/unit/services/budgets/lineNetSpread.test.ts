/**
 * Breaker r9 (the corrected rule): per (bill, PO) each PO line's postings are netted first; the bill bills max(0, sum of the line
 * nets), each positive line keeping its net less a share (by positive net, largest remainder) of the negatives; a line netting <= 0
 * bills nothing. Property (B9-5): shares sum exactly to max(0, net), each within [0, its own net].
 */
import { describe, expect, it } from 'vitest';
import { spreadLineNets } from '@/modules/accounting/services/budgets/lineNetSpread';

describe('spreadLineNets', () => {
  it('a credit stays on its own line (B9-2): A +500, B +500 -450 -> A 500, B 50', () => {
    expect(spreadLineNets([50000, 5000])).toEqual([50000, 5000]);
  });
  it('a negative line net is shared by the positive ones, by size: [300, 100, -200] -> [150, 50, 0]', () => {
    expect(spreadLineNets([30000, 10000, -20000])).toEqual([15000, 5000, 0]);
  });
  it('largest remainder, not residual on the last: [5, 3, 1, -2] -> [4, 2, 1, 0] (the cents go to the largest fractions)', () => {
    expect(spreadLineNets([5, 3, 1, -2])).toEqual([4, 2, 1, 0]);
    expect(spreadLineNets([100, 100, 100, -100])).toEqual([67, 67, 66, 0]);
  });
  it('a tie in the remainders gives the cent to the lower index: [1, 1, 1, -1] -> [1, 1, 0, 0]', () => {
    expect(spreadLineNets([1, 1, 1, -1])).toEqual([1, 1, 0, 0]);
  });
  it('breaker r10 R10-1: capped at each line total, the excess water-filled onto lines with room', () => {
    // A R100 +1000, B R1000 +1000, C R100 -900: uncapped [55000, 55000, 0] would lose A's R450 at its R100 total.
    expect(spreadLineNets([100000, 100000, -90000], [10000, 100000, 10000])).toEqual([10000, 100000, 0]);
    // Every line full: what is left is netted nowhere.
    expect(spreadLineNets([100000, 100000], [10000, 20000])).toEqual([10000, 20000]);
    // No cap binds: the same as uncapped.
    expect(spreadLineNets([30000, 10000, -20000], [99999, 99999, 99999])).toEqual([15000, 5000, 0]);
  });
  it('the water-fill weights the excess by positive net, not by room (breaker r11 pin)', () => {
    expect(spreadLineNets([47448, 74474, 75886, 9881, -52734, 95805], [44287, 47598, 63128, 156142, 99001, 95805]))
      .toEqual([43389, 47598, 63128, 9035, 0, 87610]);
  });
  it('the cap binds to the cent (breaker r11 pin): a net 1c over its cap is cut by that 1c', () => {
    expect(spreadLineNets([1001, 500], [1000, 5000])).toEqual([1000, 500]);
    expect(spreadLineNets([1001, 0], [1000, 5000])).toEqual([1000, 0]);
  });
  it('property with caps: never above min(net, cap); sums to min(max(0, PO net), the sum of those limits)', () => {
    let seed = 777;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < 2000; k++) {
      const n = 1 + Math.floor(rnd() * 7);
      const nets = Array.from({ length: n }, () => Math.round(rnd() * 80000 - 30000));
      const caps = Array.from({ length: n }, () => Math.round(rnd() * 40000));
      const out = spreadLineNets(nets, caps);
      const limits = nets.map((c, i) => Math.min(Math.max(0, c), caps[i]!));
      const want = Math.min(Math.max(0, nets.reduce((s, c) => s + c, 0)), limits.reduce((s, c) => s + c, 0));
      expect(out.reduce((s, c) => s + c, 0), JSON.stringify([nets, caps])).toBe(want);
      out.forEach((c, i) => {
        expect(c, JSON.stringify([nets, caps])).toBeGreaterThanOrEqual(0);
        expect(c, JSON.stringify([nets, caps])).toBeLessThanOrEqual(limits[i]!);
      });
    }
  });
  it('a PO net of 0 or less bills nothing', () => {
    expect(spreadLineNets([50000, -50000])).toEqual([0, 0]);
    expect(spreadLineNets([-100, 50])).toEqual([0, 0]);
    expect(spreadLineNets([])).toEqual([]);
  });
  it('property over random bills: sums to max(0, net), each share in [0, its net], non-positive lines 0', () => {
    let seed = 12345;
    // A 32-bit LCG in exact integer arithmetic (Math.imul: no float rounding of the product; review r10 LOW-3).
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < 2000; k++) {
      const nets = Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => Math.round(rnd() * 80000 - 30000));
      const out = spreadLineNets(nets);
      const want = Math.max(0, nets.reduce((s, c) => s + c, 0));
      expect(out.reduce((s, c) => s + c, 0), JSON.stringify(nets)).toBe(want);
      const totalPos = nets.reduce((s, c) => s + Math.max(0, c), 0);
      out.forEach((c, i) => {
        expect(c, JSON.stringify(nets)).toBeGreaterThanOrEqual(0);
        expect(c, JSON.stringify(nets)).toBeLessThanOrEqual(Math.max(0, nets[i]!));
        // Within a cent of its exact pro-rata share (review r10: a first-in-order remainder rule would break this).
        if (want > 0) expect(Math.abs(c - (want * Math.max(0, nets[i]!)) / totalPos), JSON.stringify(nets)).toBeLessThan(1);
      });
    }
  });
});
