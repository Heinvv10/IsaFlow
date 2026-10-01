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
 */
import { describe, expect, it } from 'vitest';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { svgBoxFor } from '@/modules/accounting/services/packs/pages/packChartBox';
import { intervalsFor, isCompact } from '@/modules/accounting/services/packs/pages/packWaterfallBars';
import { PX_PER_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { bars, clipRect, figures, illegible, outsideClip, straddlesOwnBar } from './support/bridgeSvg';
import { bridgeFuzz } from './support/bridgeFuzz';
import { renderLegacyBridge } from './support/legacyBridge';

/** The Demo company's management-pack bridge, as v67 rendered it. */
const DEMO: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 101_400, value: 101_400, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: 101_400, end: -1_329_181, value: -1_430_581, labelValue: 1_430_581, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: -1_329_181, value: -1_329_181, isSubtotal: true, color: 'teal' },
  { label: 'Operating Expenses', start: -1_329_181, end: -1_556_052, value: -226_871, labelValue: 226_871, isSubtotal: false, color: 'red' },
  { label: 'Other Income', start: -1_556_052, end: -1_544_240, value: 11_812, isSubtotal: false, color: 'green' },
  { label: 'Operating Profit', start: 0, end: -1_544_240, value: -1_544_240, isSubtotal: true, color: 'teal' },
  { label: 'Net Profit', start: 0, end: -1_544_240, value: -1_544_240, isSubtotal: true, color: 'red' },
];

/** What is wrong with a drawn bridge's figures, as sentences. */
function faults(svg: string, steps: WaterfallStep[]): string[] {
  const clip = clipRect(svg);
  const drawn = figures(svg);
  const own = bars(svg);
  return [
    ...(drawn.length === steps.length ? [] : [`${drawn.length} figures for ${steps.length} bars`]),
    ...drawn.filter((f) => outsideClip(f, clip)).map((f) => `"${f.text}" leaves the plot`),
    // In a box the layout reserved the room: no figure is left across its bar.
    ...(drawn.length === own.length ? drawn.filter((f, k) => straddlesOwnBar(f, own[k]!)).map((f) => `"${f.text}" is part on its bar and part off`) : []),
    ...illegible(svg),
  ];
}

const TITLES = ['Short title.', 'Cash moved from R 1 234 567 to R 2 345 678 over the period.',
  'Revenue of R 123 456 789 bridges to net profit of R 12 345 678, a long sentence that wraps onto a second line of the figure caption for certain.'];
const SEEDS = [424_242, 777_001, 13_579, 20_260_930];
const PER_SEED = 1_500;

describe('a bridge figure is whole and legible', () => {
  it.each([700, 900, 1100])('the Demo management pack at %ipx: "226 871" is whole', (width) => {
    const svg = renderLegacyBridge(DEMO, width, 320);
    expect(figures(svg).map((f) => f.text.replace(/\s/g, ' '))).toContain('226 871');
    expect(faults(svg, DEMO)).toEqual([]);
  });

  it.each(SEEDS)('print, in thousands, up to eight bars, every rung — seed %i', (seed) => {
    const fuzz = bridgeFuzz(seed);
    const found: string[] = [];
    let drawn = 0;
    for (let i = 0; i < PER_SEED; i += 1) {
      const { steps } = fuzz.next();
      const box = { widthMm: 174, heightMm: fuzz.pick([110, 110, 72, 72, 48]) };
      const plot = svgBoxFor(box, fuzz.pick(TITLES));
      if (steps.length > 8) continue;
      const size = { heightPx: Math.round(plot.heightMm * PX_PER_MM), widthPx: Math.round(plot.widthMm * PX_PER_MM) };
      const svg = String(renderChartSvg(
        waterfallOption(steps, "R'000", undefined, intervalsFor(box, plot.heightMm), isCompact(box), undefined, size), plot,
      ));
      drawn += 1;
      for (const fault of faults(svg, steps)) found.push(`#${i} ${box.heightMm}mm ${JSON.stringify(steps.map((s) => [s.start, s.end]))}: ${fault}`);
    }
    expect(drawn).toBeGreaterThan(PER_SEED / 2);
    expect(found.slice(0, 5), `${found.length} faults in ${drawn} charts`).toEqual([]);
  }, 120_000);

  it.each(SEEDS)('the management pack, up to eight bars, 700 and 900px — seed %i', (seed) => {
    const fuzz = bridgeFuzz(seed);
    const found: string[] = [];
    let drawn = 0;
    for (let i = 0; i < PER_SEED; i += 1) {
      const { steps } = fuzz.next();
      const width = fuzz.pick([700, 900]);
      if (steps.length > 8) continue;
      const svg = renderLegacyBridge(steps, width, 320);
      drawn += 1;
      for (const fault of faults(svg, steps)) found.push(`#${i} ${width}px ${JSON.stringify(steps.map((s) => [s.start, s.end]))}: ${fault}`);
    }
    expect(drawn).toBeGreaterThan(PER_SEED / 2);
    expect(found.slice(0, 5), `${found.length} faults in ${drawn} charts`).toEqual([]);
  }, 120_000);
});
