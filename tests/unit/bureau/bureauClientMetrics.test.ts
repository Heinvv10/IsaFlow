import { describe, it, expect } from 'vitest';
import { shapeClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';

describe('shapeClientMetrics', () => {
  it('maps numeric inputs and computes profit = revenue - expenses', () => {
    const m = shapeClientMetrics({ cash: 142000, ar: 88000, ap: 31000, revenue: 210000, expenses: 146000 });
    expect(m).toEqual({ cash: 142000, ar: 88000, ap: 31000, revenueMtd: 210000, profitMtd: 64000 });
  });

  it('coerces numeric-string driver values (no NaN)', () => {
    const m = shapeClientMetrics({ cash: '100.50', ar: '0', ap: '25', revenue: '300', expenses: '120' });
    expect(m.cash).toBeCloseTo(100.5, 2);
    expect(m.profitMtd).toBeCloseTo(180, 2);
  });

  it('coalesces null / undefined / non-numeric to 0', () => {
    const m = shapeClientMetrics({ cash: null, ar: undefined, ap: 'x', revenue: null, expenses: null });
    expect(m).toEqual({ cash: 0, ar: 0, ap: 0, revenueMtd: 0, profitMtd: 0 });
  });

  it('profit goes negative when expenses exceed revenue', () => {
    const m = shapeClientMetrics({ cash: 0, ar: 0, ap: 0, revenue: 100, expenses: 250 });
    expect(m.profitMtd).toBe(-150);
  });
});
