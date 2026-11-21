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
  it('largest remainder, not residual on the last: [1, 1, 1, -1] -> [1, 1, 0] sums to 2, none above its net', () => {
    expect(spreadLineNets([100, 100, 100, -100])).toEqual([67, 67, 66, 0]);
    expect(spreadLineNets([1, 1, 1, -1])).toEqual([1, 1, 0, 0]);
  });
  it('a PO net of 0 or less bills nothing', () => {
    expect(spreadLineNets([50000, -50000])).toEqual([0, 0]);
    expect(spreadLineNets([-100, 50])).toEqual([0, 0]);
    expect(spreadLineNets([])).toEqual([]);
  });
  it('property over random bills: sums to max(0, net), each share in [0, its net], non-positive lines 0', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let k = 0; k < 2000; k++) {
      const nets = Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => Math.round(rnd() * 80000 - 30000));
      const out = spreadLineNets(nets);
      const want = Math.max(0, nets.reduce((s, c) => s + c, 0));
      expect(out.reduce((s, c) => s + c, 0), JSON.stringify(nets)).toBe(want);
      out.forEach((c, i) => {
        expect(c, JSON.stringify(nets)).toBeGreaterThanOrEqual(0);
        expect(c, JSON.stringify(nets)).toBeLessThanOrEqual(Math.max(0, nets[i]!));
      });
    }
  });
});
