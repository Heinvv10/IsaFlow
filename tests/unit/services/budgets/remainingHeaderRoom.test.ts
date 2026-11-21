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
  it('water-fills: what the pro-rata pass could not place goes to lines with room left, in order (breaker R4-3)', () => {
    const room = [...Array(40).fill(10000), 1];
    expect(spreadOverRoom(400000, room).reduce((s, c) => s + c, 0)).toBe(400000);
    expect(spreadOverRoom(400001, room).reduce((s, c) => s + c, 0)).toBe(400001);
    expect(spreadOverRoom(3, [1, 1, 1])).toEqual([1, 1, 1]);
    for (const [cents, rooms] of [[999, [7, 500, 3, 600]], [12345, [1, 1, 99999]], [5, [2, 2, 2]]] as const) {
      const out = spreadOverRoom(cents, rooms);
      expect(out.reduce((s, c) => s + c, 0)).toBe(Math.min(cents, rooms.reduce((s, c) => s + c, 0)));
      out.forEach((c, i) => expect(c).toBeLessThanOrEqual(rooms[i]!));
    }
  });
  it('never puts more on a line than its room; what is left after every line is full is netted nowhere', () => {
    expect(spreadOverRoom(90000, [20000, 30000])).toEqual([20000, 30000]);
    expect(spreadOverRoom(500, [0, 0])).toEqual([0, 0]);
  });
});
