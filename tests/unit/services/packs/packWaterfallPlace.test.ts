/**
 * `placeFigures`, ON GEOMETRY CHOSEN TO MEET EACH RULE ONCE.
 *
 * The fuzz in `packBridgeFigureLegible` holds the drawn charts; a seeded
 * bridge rarely puts a wide outside figure beside a neighbour's INSIDE one,
 * so that rule and the other three are met here directly, on bars built to
 * do it.
 */
import { describe, expect, it } from 'vitest';
import { placeFigures, type BarPx, type Placement } from '@/modules/accounting/services/packs/packWaterfallPlace';

const PLOT = { left: 0, right: 400, top: 0, bottom: 300 };
const PX = 12;
const bar = (over: Partial<BarPx>): BarPx => ({
  centre: 100, top: 100, height: 60, drawnHeight: 60, width: 60, rises: true, falls: false, subtotal: false, text: '1 234', ...over,
});
/** How far apart two figures' boxes stand; negative where they overlap. */
const gap = (a: Placement, b: Placement): number => Math.max(
  Math.abs(a.centre - b.centre) - a.halfWidth - b.halfWidth, Math.abs(a.top - b.top) - PX,
);

describe('placeFigures', () => {
  it('sets two adjacent falling bars\' figures on different lines when they would meet', () => {
    const bars = [bar({ centre: 100, top: 100, falls: true, rises: false, text: '(54 884 558)' }),
      bar({ centre: 170, top: 100, falls: true, rises: false, text: '(299 064 370)' })];
    const [a, b] = placeFigures(bars, PLOT, PX, false);
    expect(a!.level).toBe(0);
    expect(b!.level).toBe(1);
    expect(b!.below).toBe(true);
    expect(gap(a!, b!)).toBeGreaterThanOrEqual(3);
  });

  it('moves an outside figure off a neighbour\'s INSIDE figure, whichever side the neighbour is on', () => {
    // The first bar rises a little: its wide figure sits above it, at the
    // height where the tall subtotal beside it carries its own figure inside.
    const bars = [bar({ centre: 100, top: 120, height: 5, drawnHeight: 5, text: '123 456 789 012' }),
      bar({ centre: 170, top: 100, height: 150, drawnHeight: 150, subtotal: true, text: '9 999 999' })];
    const [outside, inside] = placeFigures(bars, PLOT, PX, false);
    expect(inside!.inside).toBe(true);
    expect(outside!.inside).toBe(false);
    expect(outside!.level).toBeGreaterThan(0);
    expect(gap(outside!, inside!)).toBeGreaterThanOrEqual(3);
  });

  it('keeps a wide figure on the first bar inside the plot, and checks it for collisions where it lands', () => {
    const bars = [bar({ centre: 20, top: 100, height: 5, drawnHeight: 5, text: '123 456 789' }),
      bar({ centre: 90, top: 100, height: 5, drawnHeight: 5, text: '987 654 321' })];
    const [first, second] = placeFigures(bars, PLOT, PX, false);
    expect(first!.centre - first!.halfWidth).toBeGreaterThanOrEqual(PLOT.left);
    expect(gap(first!, second!)).toBeGreaterThanOrEqual(3);
  });

  it('holds a figure inside the plot\'s height only when asked to', () => {
    const top = [bar({ top: 4, height: 5, drawnHeight: 5 })];
    expect(placeFigures(top, PLOT, PX, false)[0]!.top).toBeLessThan(PLOT.top);
    expect(placeFigures(top, PLOT, PX, true)[0]!.top).toBe(PLOT.top);
  });

  it('takes nothing to fit a bar of unknown width', () => {
    const [p] = placeFigures([bar({ width: undefined, subtotal: true, height: 200, drawnHeight: 200 })], PLOT, PX, false);
    expect(p!.inside).toBe(false);
  });
});
