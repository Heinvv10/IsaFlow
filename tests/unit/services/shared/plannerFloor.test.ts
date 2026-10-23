import { describe, it, expect } from 'vitest';
import { invoiceFloor, planGreedyAllocations } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { simulateSequentialApplications } from '@/modules/accounting/services/shared/autoApplySimulation';

const DOCS = [
  { invoiceId: 'a', outstanding: 100 },
  { invoiceId: 'b', outstanding: 0.01 },
];

describe('planGreedyAllocations line floor', () => {
  it('defaults to a cent: a one-cent line is skipped', () => {
    expect(planGreedyAllocations(100.01, DOCS)).toEqual([{ invoiceId: 'a', amount: 100 }]);
  });

  it('with the customer floor the last cent is applied', () => {
    expect(planGreedyAllocations(100.01, DOCS, invoiceFloor('customer'))).toEqual([
      { invoiceId: 'a', amount: 100 }, { invoiceId: 'b', amount: 0.01 },
    ]);
    expect(planGreedyAllocations(0.01, [DOCS[1]!], invoiceFloor('customer'))).toEqual([{ invoiceId: 'b', amount: 0.01 }]);
  });

  it('the supplier floor is the cent tolerance', () => {
    expect(invoiceFloor('supplier')).toBe(0.01);
    expect(planGreedyAllocations(100.01, DOCS, invoiceFloor('supplier'))).toEqual([{ invoiceId: 'a', amount: 100 }]);
  });

  it('never writes a zero line or runs past exhausted cash', () => {
    expect(planGreedyAllocations(0, DOCS, 0)).toEqual([]);
    expect(planGreedyAllocations(100, DOCS, 0)).toEqual([{ invoiceId: 'a', amount: 100 }]);
  });
});

describe('simulateSequentialApplications carries the line floor', () => {
  const open = new Map([['e', DOCS.map((d) => ({ ...d, invoiceNumber: d.invoiceId.toUpperCase() }))]]);
  const line = { index: 0, entityKey: 'e', cash: 100.01, oldestFirst: true };

  it('a customer line (floor 0) previews the last cent, as the live planner writes it', () => {
    const [sim] = simulateSequentialApplications([{ ...line, floor: invoiceFloor('customer') }], open);
    expect(sim!.applications.map((a) => a.amount)).toEqual([100, 0.01]);
    expect(sim!.onAccount).toBe(0);
  });

  it('a line with no floor keeps the supplier tolerance', () => {
    const [sim] = simulateSequentialApplications([line], open);
    expect(sim!.applications.map((a) => a.amount)).toEqual([100]);
    expect(sim!.onAccount).toBe(0.01);
  });
});
