/** Header billing spreads over each PO line's ROOM left after its line billing (breaker R3-1): budgets/remainingHeaderBilled. */
import { describe, expect, it } from 'vitest';
import { spreadOverRoom } from '@/modules/accounting/services/budgets/remainingHeaderBilled';

describe('spreadOverRoom', () => {
  it('a line already billed by its lines takes nothing: the header amount goes where there is room', () => {
    expect(spreadOverRoom(50000, [0, 50000])).toEqual([0, 50000]);
  });
  it('spreads by room, the residual on the last line with room', () => {
    expect(spreadOverRoom(10000, [10000, 10000, 10000])).toEqual([3333, 3333, 3334]);
    expect(spreadOverRoom(101, [100, 100, 0])).toEqual([50, 51, 0]);
  });
  it('never puts more on a line than its room; what is left after every line is full is netted nowhere', () => {
    expect(spreadOverRoom(90000, [20000, 30000])).toEqual([20000, 30000]);
    expect(spreadOverRoom(500, [0, 0])).toEqual([0, 0]);
  });
});
