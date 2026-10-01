/**
 * W3-01 review round 2 (BRK-596 R2-5): the labour split's rounding cent goes to
 * the largest line — and on a TIE, to the same line whatever order the run's
 * lines arrive in. It was the first-largest in the order of an unordered
 * SELECT, so heap order decided which cost centre carried the cent, and with
 * it the posted journal and the plan hash.
 */
import { describe, it, expect } from 'vitest';
import { labourRoundingSlackCents, placeLabourRounding } from '@/modules/accounting/services/payroll/payrollJournalSplitBuilder';

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

/**
 * W3-01 review round 3: how many cents of the split depend on the order the
 * run's lines and allocations were READ in. Before round 2 that order was the
 * heap's, so a journal posted then may carry those cents on other labour
 * accounts than the plan does now; the approval gate allows exactly this much.
 */
describe('labourRoundingSlackCents', () => {
  const half = [{ costCentreId: 'cc-1', percentage: 50 }, { costCentreId: 'cc-2', percentage: 50 }];

  it('is zero when nothing was rounded: no split, and a unique largest line', () => {
    const untied = [{ employeeId: 'e-a', labourAmount: 50 }, { employeeId: 'e-b', labourAmount: 20 }];
    expect(labourRoundingSlackCents(untied, placeLabourRounding(untied, 70), {})).toBe(0);
    // A cent of rounding on a UNIQUE largest line lands there in any order.
    expect(labourRoundingSlackCents(untied, placeLabourRounding(untied, 70.01), {})).toBe(0);
    // An even amount halves exactly.
    expect(labourRoundingSlackCents(untied, untied, { 'e-a': half })).toBe(0);
  });

  it('counts the cent a split leaves over, which went to whichever share was read last', () => {
    const lines = [{ employeeId: 'e-a', labourAmount: 20177.13 }];
    expect(labourRoundingSlackCents(lines, lines, { 'e-a': half })).toBe(1);
  });

  it('counts the rounding moved onto a TIED largest line, which went to whichever was read first', () => {
    expect(labourRoundingSlackCents(lines(), placeLabourRounding(lines(), 120.01), {})).toBe(1);
    // …and a tied line that is itself split may round differently with the cent on it.
    expect(labourRoundingSlackCents(lines(), placeLabourRounding(lines(), 120.01), { 'e-a': half })).toBe(2);
  });

  it('never allows more than rounding: shares that do not sum to 100 leave a real remainder', () => {
    const lines = [{ employeeId: 'e-a', labourAmount: 1000 }];
    const short = [{ costCentreId: 'cc-1', percentage: 50 }, { costCentreId: 'cc-2', percentage: 30 }];
    expect(labourRoundingSlackCents(lines, lines, { 'e-a': short })).toBe(1);
  });
});
