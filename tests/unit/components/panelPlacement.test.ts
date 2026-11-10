/** UXB (wave 5): the side is chosen once at open; the panel never outgrows the room on its side. */
import { describe, it, expect } from 'vitest';
import { chooseSide, placePanel } from '@/components/ui/panelPlacement';

const VH = 900;

describe('chooseSide', () => {
  it('down with room below', () => expect(chooseSide({ top: 100, bottom: 132 }, VH, 300)).toBe('down'));
  it('up near the bottom when there is more room above', () => expect(chooseSide({ top: 800, bottom: 832 }, VH, 300)).toBe('up'));
  it('down when both sides are short but below is larger', () => expect(chooseSide({ top: 150, bottom: 182 }, 400, 300)).toBe('down'));
  it('down for a short list that fits below, even near the bottom', () => expect(chooseSide({ top: 800, bottom: 832 }, VH, 40)).toBe('down'));
});

describe('placePanel', () => {
  it('down: top under the trigger, height = the room below', () => {
    expect(placePanel({ top: 100, bottom: 132 }, VH, 'down')).toEqual({ top: 136, maxHeight: 900 - 132 - 12 });
  });

  it('up: anchored above the trigger, height = the room above', () => {
    const p = placePanel({ top: 800, bottom: 832 }, VH, 'up');
    expect(p).toEqual({ bottom: VH - 800 + 4, maxHeight: 800 - 12 });
    expect(p.top).toBeUndefined();
  });

  it('a short viewport gets a short panel: the room on its side', () => {
    expect(placePanel({ top: 150, bottom: 182 }, 400, 'down').maxHeight).toBe(400 - 182 - 12);
  });

  it('never invisible: with no room at all it keeps a search box plus one option (88 px)', () => {
    expect(placePanel({ top: 0, bottom: 40 }, 40, 'down').maxHeight).toBe(88);
    expect(placePanel({ top: 10, bottom: 40 }, 40, 'up').maxHeight).toBe(88);
  });
});
