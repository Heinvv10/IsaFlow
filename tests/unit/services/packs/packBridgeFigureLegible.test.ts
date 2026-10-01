/**
 * EVERY BRIDGE FIGURE IS WHOLE AND LEGIBLE — MEASURED OFF THE PAINT, NOT THE RULE.
 *
 * A figure is in one of two states. It fits inside its bar — the bar is as
 * tall as a line of type with its padding AND as wide as the figure — and is
 * drawn there in the ink that reads on the fill; or it does not, and is drawn
 * wholly outside on its own side in ordinary ink, in room the layout reserved
 * for it. There is no third state: the management pack printed "226 871" in
 * paper ink half on a bar too short for it, the lower half of every digit
 * white on white (evidence/v67/zoom-mgmt-demo-p8-08.png).
 *
 * The checks here do not know that rule. `lostGlyphs` reads, per glyph, what
 * the SVG paints under and over it in document order and what the plot's clip
 * cuts, and asks for 3:1 against whatever that is.
 *
 * AND NO FIGURE MEETS ANOTHER. On a bridge ending on a falling movement into
 * a negative closing balance the last two figures stood at one height in
 * adjacent bands, and the later one's halo erased the earlier one's digits:
 * "(54 884 558)" printed as "(54 884 5". `textOnText` holds every pair of
 * glyph boxes apart by more than a halo.
 *
 * The print bridges are drawn with the arguments their two callers pass
 * (`bridgeFuzz().print`), not a narrower set of this file's own.
 */
import { describe, expect, it } from 'vitest';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { MIN_TICK_PITCH_PX } from '@/modules/accounting/services/packs/packChartAxes';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { bars, boxOf, clipRect, figures, haloOrder, illegible, onNeighbourBars, outsideClip, straddlesOwnBar, textOnText, wrongSide } from './support/bridgeSvg';
import { outsideSvg } from './support/svgBounds';
import { yAxisTicks } from './support/svgTicks';
import { bridgeFuzz } from './support/bridgeFuzz';
import { LEGACY_WATERFALL_BOX } from '@/components/accounting/packs/PackSectionView';
import { DEMO_MANAGEMENT_BRIDGE, renderLegacyBridge } from './support/legacyBridge';

const DEMO = DEMO_MANAGEMENT_BRIDGE;

/** What is wrong with a drawn bridge, as sentences. */
function faults(svg: string, steps: WaterfallStep[]): string[] {
  const clip = clipRect(svg);
  const drawn = figures(svg);
  const own = bars(svg);
  // A count that is off is itself the fault: every check below pairs the
  // k-th figure with the k-th bar.
  if (drawn.length !== steps.length || own.length !== steps.length) return [`${drawn.length} figures and ${own.length} bars for ${steps.length} steps`];
  const ticks = yAxisTicks(svg).map((t) => t.y).sort((a, b) => a - b);
  const tickTexts = yAxisTicks(svg).map((t) => t.text);
  const pitch = Math.min(Infinity, ...ticks.slice(1).map((y, i) => y - ticks[i]!));
  return [
    ...drawn.filter((f) => outsideClip(f, clip)).map((f) => `"${f.text}" leaves the plot`),
    // In a box the layout reserved the room: no figure is left across its bar.
    ...drawn.filter((f, k) => straddlesOwnBar(f, own[k]!)).map((f) => `"${f.text}" is part on its bar and part off`),
    ...drawn.filter((f, k) => steps[k]!.end !== steps[k]!.start && wrongSide(f, own[k]!, steps[k]!.end > steps[k]!.start)).map((f) => `"${f.text}" is on the wrong side of its bar`),
    ...textOnText(svg),
    ...onNeighbourBars(svg),
    ...outsideSvg(svg),
    ...illegible(svg),
    ...(pitch < MIN_TICK_PITCH_PX - 0.01 ? [`value ticks ${pitch.toFixed(1)}px apart`] : []),
    // No figure on two ticks: "2 | 1 | 1 | –" under four thousand at R'000.
    ...(new Set(tickTexts).size === tickTexts.length ? [] : [`value ticks repeat: ${tickTexts.join(' | ')}`]),
  ];
}

const SEEDS = [424_242, 777_001, 13_579, 20_260_930, 5_550_123, 31_415_927];
/** Per seed and per path. Sized so the pack's fuzz tests together stay near a
 *  minute of the unit run; the raster harness runs thousands more per seed. */
const PER_SEED = 320;
/** Per seed, for the neighbour-bar class. */
const NEIGHBOUR_CASES = 24;
/** The one box the management pack's print view draws its bridge in. */
const BOX = LEGACY_WATERFALL_BOX;

describe('a bridge figure is whole and legible', () => {
  it('the Demo management pack, in its print box: "226 871" is whole', () => {
    const svg = renderLegacyBridge(DEMO, BOX.widthPx, BOX.heightPx);
    expect(figures(svg).map((f) => f.text.replace(/\s/g, ' '))).toContain('226 871');
    expect(faults(svg, DEMO)).toEqual([]);
  });

  it('the reviewer\'s falling movement into a negative closing balance: neither figure meets the other', () => {
    const steps: WaterfallStep[] = [[0, -48_010_562], [-48_010_562, -96_755_403], [-96_755_403, -137_618_153], [-137_618_153, -174_428_941],
      [-174_428_941, -238_593_828], [-238_593_828, -244_179_812], [-244_179_812, -299_064_370], [0, -299_064_370]]
      .map(([start, end], i, all) => ({ label: `Step ${i + 1}`, start: start!, end: end!, value: end! - start!, isSubtotal: i === 0 || i === all.length - 1, color: 'red' }));
    expect(faults(renderLegacyBridge(steps, BOX.widthPx, BOX.heightPx), steps)).toEqual([]);
  });

  it('paints every halo beneath every figure, so no halo can erase a digit', () => {
    const svg = renderLegacyBridge(DEMO, BOX.widthPx, BOX.heightPx);
    const order = haloOrder(svg);
    expect(order.halos, 'no figure outside its bar, so no halo is under test').toBeGreaterThan(2);
    expect(order.allBeneath).toBe(true);
  });

  // OFF-SIZE, ON PURPOSE: these two are not a box production draws. Whole-rand
  // figures in the billions on a 480px chart are what it takes to reach the
  // type-size step, which the print box's own bridges do not — clearing them
  // at twelve would stagger one more than two lines out.
  const CROWDED: Array<[number, Array<[number, number, boolean]>]> = [
    [10, [[0, -7_204_853_135, true], [-7_204_853_135, 19_907_806_913, false], [19_907_806_913, 36_881_253_575, false],
      [36_881_253_575, 7_834_553_528, false], [7_834_553_528, 29_677_401_479, false], [0, 29_677_401_479, true]]],
    [9, [[0, 39_809_131_502, true], [39_809_131_502, 47_160_985_871, false], [47_160_985_871, -61_412_785_201, false], [-61_412_785_201, -55_552_989_645, false],
      [-55_552_989_645, 443_737_210_049, false], [443_737_210_049, 452_015_167_830, false], [452_015_167_830, 463_558_329_639, false], [0, 463_558_329_639, true]]],
  ];
  it.each(CROWDED)('off-size, 480px: a crowded bridge sets every figure at %ipx rather than stagger them past two lines', (px, shape) => {
    const steps: WaterfallStep[] = shape.map(([start, end, isSubtotal], i) => ({ label: `Step ${i + 1}`, start, end, value: end - start, isSubtotal, color: end >= start ? 'green' : 'red' }));
    const svg = renderLegacyBridge(steps, 480, 320);
    expect([...new Set(figures(svg).map((f) => f.px))]).toEqual([px]);
    expect(faults(svg, steps)).toEqual([]);
  });

  it('and an ordinary bridge keeps twelve', () => {
    expect([...new Set(figures(renderLegacyBridge(DEMO, BOX.widthPx, BOX.heightPx)).map((f) => f.px))]).toEqual([12]);
  });

  it.each(SEEDS)('print, as the profit and cash callers draw it, every rung — seed %i', (seed) => {
    const fuzz = bridgeFuzz(seed);
    const found: string[] = [];
    for (let i = 0; i < PER_SEED; i += 1) {
      const c = fuzz.print();
      const svg = String(renderChartSvg(waterfallOption(c.steps, "R'000", undefined, c.ask, c.compact, undefined, c.box), c.plot));
      for (const fault of faults(svg, c.steps)) found.push(`#${i} ${c.tag} ${JSON.stringify(c.steps.map((s) => [s.start, s.end]))}: ${fault}`);
    }
    expect(found.slice(0, 5), `${found.length} faults in ${PER_SEED} charts`).toEqual([]);
  }, 180_000);

  it.each(SEEDS)('wide figures on short bars between tall ones stay off the neighbours\' bars — seed %i', (seed) => {
    const fuzz = bridgeFuzz(seed);
    const found: string[] = [];
    let wide = 0;
    for (let i = 0; i < NEIGHBOUR_CASES; i += 1) {
      const steps = fuzz.neighbours();
      // The management pack in its print box, in rands, and the board pack's
      // tallest rung in thousands — where the same shape is a figure wide.
      const legacy = renderLegacyBridge(steps, BOX.widthPx, BOX.heightPx);
      const print = String(renderChartSvg(waterfallOption(steps, 'R', undefined, 11, false, undefined, { widthPx: 658, heightPx: 391 }), { widthMm: 174, heightMm: 103.4 }));
      for (const [path, svg] of [['legacy', legacy], ['print', print]] as const) {
        const own = bars(svg);
        wide += figures(svg).filter((f, k) => own[k] !== undefined && boxOf(f).right - boxOf(f).left > (own[k]!.right! - own[k]!.left!) * 2).length;
        for (const fault of faults(svg, steps)) found.push(`#${i} ${path} ${JSON.stringify(steps.map((s) => [s.start, s.end]))}: ${fault}`);
      }
    }
    // NOT VACUOUS: the shape does put figures twice their bar's width there.
    expect(wide).toBeGreaterThan(NEIGHBOUR_CASES);
    expect(found.slice(0, 5), `${found.length} faults`).toEqual([]);
  }, 60_000);

  it.each(SEEDS)('the management pack in its print box, profit and random shapes — seed %i', (seed) => {
    const fuzz = bridgeFuzz(seed);
    const found: string[] = [];
    for (let i = 0; i < PER_SEED; i += 1) {
      // Revenue from a hundred thousand to two billion; random shapes from a
      // thousand to a billion. Whole rands, as the management pack prints.
      const profit = fuzz.rnd() < 0.6;
      const steps = profit ? fuzz.profit(Math.pow(10, 5 + fuzz.rnd() * 4.3)) : fuzz.random(Math.pow(10, 3 + fuzz.rnd() * 6));
      const svg = renderLegacyBridge(steps, BOX.widthPx, BOX.heightPx);
      for (const fault of faults(svg, steps)) found.push(`#${i} ${profit ? 'profit' : 'random'} ${JSON.stringify(steps.map((s) => [s.start, s.end]))}: ${fault}`);
    }
    expect(found.slice(0, 5), `${found.length} faults in ${PER_SEED} charts`).toEqual([]);
  }, 180_000);
});
