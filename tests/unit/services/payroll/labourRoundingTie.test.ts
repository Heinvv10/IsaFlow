/**
 * W3-01 review round 2 (BRK-596 R2-5): the labour split's rounding cent goes to
 * the largest line — and on a TIE, to the same line whatever order the run's
 * lines arrive in. It was the first-largest in the order of an unordered
 * SELECT, so heap order decided which cost centre carried the cent, and with
 * it the posted journal and the plan hash.
 */
import { describe, it, expect } from 'vitest';
import { placeLabourRounding } from '@/modules/accounting/services/payroll/payrollJournalSplitBuilder';

const lines = () => [
  { employeeId: 'e-b', labourAmount: 50 },
  { employeeId: 'e-a', labourAmount: 50 },
  { employeeId: 'e-c', labourAmount: 20 },
];

describe('placeLabourRounding', () => {
  it('puts a tied rounding cent on the same line in every input order', () => {
    const orders = [[0, 1, 2], [1, 0, 2], [2, 1, 0], [2, 0, 1], [0, 2, 1], [1, 2, 0]];
    const winners = orders.map((o) => {
      const base = lines();
      const placed = placeLabourRounding(o.map((i) => base[i]!), 120.01);
      return placed.filter((l) => l.labourAmount === 50.01).map((l) => l.employeeId);
    });
    expect(new Set(winners.map((w) => w.join()))).toEqual(new Set(['e-a']));
  });

  it('leaves the lines alone when they already sum, and never absorbs more than rounding', () => {
    expect(placeLabourRounding(lines(), 120).map((l) => l.labourAmount)).toEqual([50, 50, 20]);
    expect(placeLabourRounding(lines(), 125).map((l) => l.labourAmount)).toEqual([50, 50, 20]);
  });
});
