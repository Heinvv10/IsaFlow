/** The pro rata spread of header billing over a PO's lines (budgets/remainingHeaderBilled.spreadCents). */
import { describe, expect, it } from 'vitest';
import { spreadCents } from '@/modules/accounting/services/budgets/remainingHeaderBilled';

describe('spreadCents', () => {
  it('spreads by line share, the residual on the last line', () => {
    expect(spreadCents(30000, [10000, 20000, 70000])).toEqual([3000, 6000, 21000]);
    expect(spreadCents(10000, [10000, 10000, 10000])).toEqual([3333, 3333, 3334]);
  });

  it('puts the residual on the last line WITH a positive total, never on a zero or negative line', () => {
    expect(spreadCents(101, [100, 100, 0])).toEqual([50, 51, 0]);
    expect(spreadCents(101, [100, 100, -20])).toEqual([50, 51, 0]);
    expect(spreadCents(7, [0, 3, 0, 4, 0])).toEqual([0, 3, 0, 4, 0]);
  });

  it('takes nothing when no line has a positive total', () => {
    expect(spreadCents(500, [0, 0])).toEqual([0, 0]);
    expect(spreadCents(500, [])).toEqual([]);
  });
});
