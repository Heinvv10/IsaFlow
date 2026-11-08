/** UXB (wave 5): a dropdown opens downward unless there is less room below and more above; it never outgrows the room. */
import { describe, it, expect } from 'vitest';
import { placePanel } from '@/components/ui/panelPlacement';

const VH = 900;

describe('placePanel', () => {
  it('opens downward with room below', () => {
    expect(placePanel({ top: 100, bottom: 132 }, VH, 300)).toEqual({ top: 136, maxHeight: 900 - 132 - 12 });
  });

  it('flips upward near the bottom when there is more room above', () => {
    const p = placePanel({ top: 800, bottom: 832 }, VH, 300);
    expect(p).toEqual({ bottom: VH - 800 + 4, maxHeight: 800 - 12 });
    expect(p.top).toBeUndefined();
  });

  it('stays downward when both sides are short but below is larger (a short viewport, a row near the top)', () => {
    const p = placePanel({ top: 150, bottom: 182 }, 400, 300);
    expect(p.top).toBe(186);
    expect(p.maxHeight).toBe(400 - 182 - 12);
  });

  it('never returns a negative height', () => {
    expect(placePanel({ top: 0, bottom: 40 }, 40, 300).maxHeight).toBe(0);
  });
});
