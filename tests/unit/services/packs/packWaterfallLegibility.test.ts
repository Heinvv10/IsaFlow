/**
 * CAN A DIRECTOR READ THE BRIDGE — IN COLOUR, AND PHOTOCOPIED?
 *
 * Three defects reached a rendered pack, and none of them was visible to any
 * check in the suite: every one is a property of the SVG rather than of the
 * model, and the model was right in all three cases.
 *
 * 1. THE TOTAL BARS CARRIED NO VALUE. The label was drawn — it was drawn in
 *    `ink`, INSIDE an ink-filled bar. Sheets 6 and 8 printed Gross Profit,
 *    Net Profit, Opening cash and Closing cash with nothing on them, so
 *    red/green hue was the only thing separating an increase from a decrease
 *    on the four largest marks in the pack, with no shape, hatch or direct
 *    label behind it.
 * 2. THE COLOUR MEANT OPPOSITE THINGS IN TWO PACKS. It followed the direction
 *    the step moved the running total, which inverts on a company in loss:
 *    Brightsphere drew operating expenses of 3 717 in GREEN and revenue of
 *    (5 535) in RED, on the rubric that draws cost of sales red and revenue
 *    green in the demo pack.
 * 3. THE AXIS DID NOT CONTAIN ITS OWN DATA, or contained it as a tick. The
 *    demo cash bridge labelled (100) … (500) and its last bar closed at
 *    (548); Brightsphere's income bridge ran (1 000) … (5 000), (5 535) —
 *    four round numbers and one observation used as a scale mark.
 *
 * Every assertion below reads the SVG the pack actually carries. Mutating the
 * production code back to any of the three turns one of them red.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCashWaterfallChart,
  buildProfitWaterfallChart,
} from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { brightsphereSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';

/**
 * A drawn bar and the label on it, paired by DOCUMENT ORDER.
 *
 * `renderItem` emits each bar as a `<path>` immediately followed by its own
 * `<text>`, so the pairing is the renderer's own and no coordinate matching
 * is guessed. The `ecmeta_data_index` attribute is asserted rather than
 * assumed: if zrender ever stops emitting the two together, this finds no
 * bars and the vacuity check below fails loudly instead of passing empty.
 */
interface Bar {
  index: number;
  fill: string;
  label: string;
  labelFill: string;
  /** What the label is actually printed ON: the bar's own fill where the
   *  label sits inside the rect, the sheet where it sits above or below it.
   *  Read off the geometry rather than assumed — the renderer moves the
   *  label to whichever of the three positions has room, and a test that
   *  guessed would pass an invisible label in one of them. */
  behind: string;
}

const PAPER = '#ffffff';

function bars(svg: string): Bar[] {
  const pattern = /<path\b[^>]*d="M([-\d.]+) ([-\d.]+)l[-\d.]+ 0l0 ([-\d.]+)l[^"]*"[^>]*fill="(#[0-9a-f]{6})"[^>]*ecmeta_data_index="(\d+)"[^>]*><\/path>\s*<text\b[^>]*\by="([-\d.]+)"[^>]*fill="(#[0-9a-f]{6})"[^>]*>([^<]*)<\/text>/gi;
  const out: Bar[] = [];
  for (const m of svg.matchAll(pattern)) {
    const top = Number(m[2]);
    const height = Number(m[3]);
    const labelY = Number(m[6]);
    out.push({
      index: Number(m[5]),
      fill: m[4]!.toLowerCase(),
      labelFill: m[7]!.toLowerCase(),
      label: m[8] ?? '',
      behind: labelY >= top && labelY <= top + height ? m[4]!.toLowerCase() : PAPER,
    });
  }
  return out;
}

/** Perceived lightness, 0–255. The one channel a photocopier keeps. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The value-axis tick labels, top to bottom, as the numbers they read as.
 *  `formatMoney`'s bracket convention and thin-space grouping are undone
 *  here, so a tick that stops being a number fails rather than parsing to 0. */
function axisTicks(svg: string): number[] {
  const out: Array<{ y: number; value: number }> = [];
  for (const m of svg.matchAll(/<text\b([^>]*)transform="translate\(72 ([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)) {
    const text = (m[3] ?? '').replace(/&#160;|&#8201;|\s/g, '');
    const negative = text.startsWith('(');
    const digits = text.replace(/[()]/g, '');
    const value = digits === '–' || digits === '&#8211;' ? 0 : Number(digits);
    expect(Number.isFinite(value), `tick "${m[3]}" did not read as a number`).toBe(true);
    out.push({ y: Number(m[2]), value: negative ? -value : value });
  }
  return out.sort((a, b) => a.y - b.y).map((t) => t.value);
}

const PACKS = [
  ['the live demo company', liveDemoSet],
  ['the demo company', demoSet],
  ['Brightsphere', brightsphereSet],
] as const;

function charts(set: typeof demoSet): Array<[string, string]> {
  const out: Array<[string, string]> = [['income bridge', String(buildProfitWaterfallChart(set, PACK_SCALE).svg)]];
  const cash = buildCashWaterfallChart(set, PACK_SCALE);
  if (cash.drawn) out.push(['cash bridge', String(cash.chart.svg)]);
  return out;
}

describe('every bar on a pack bridge', () => {
  for (const [company, set] of PACKS) {
    for (const [chart, svg] of charts(set)) {
      it(`carries a legible value on ${company}'s ${chart}`, () => {
        const drawn = bars(svg);
        // Not vacuous: a regex that matches nothing would pass every
        // assertion in the loop below.
        expect(drawn.length, 'no bars were found in the SVG').toBeGreaterThan(2);

        for (const bar of drawn) {
          expect(bar.label.trim(), `bar ${bar.index} has an empty label`).not.toBe('');
          const separation = Math.abs(luminance(bar.behind) - luminance(bar.labelFill));
          expect(
            separation,
            `bar ${bar.index}'s label "${bar.label}" is ${bar.labelFill} on ${bar.behind} — `
              + `${separation.toFixed(1)} of 255 apart in lightness, which is not a label a `
              + 'reader can see',
          ).toBeGreaterThan(64);
        }
      });

      it(`sits on a round, containing axis on ${company}'s ${chart}`, () => {
        const ticks = axisTicks(svg);
        expect(ticks.length, 'no y-axis ticks were found').toBeGreaterThan(2);

        // ONE STEP, EVERY GRIDLINE. An axis whose last tick is the extreme
        // observation breaks the progression, which is exactly Brightsphere's
        // (5 000) then (5 535).
        const step = ticks[1]! - ticks[0]!;
        for (let i = 1; i < ticks.length; i += 1) {
          expect(
            ticks[i]! - ticks[i - 1]!,
            `the axis reads ${ticks.join(' / ')} — its gridlines are not one step apart`,
          ).toBeCloseTo(step, 6);
        }
        // And the step is a round one: 1, 2 or 5 times a power of ten.
        const magnitude = Math.abs(step) / Math.pow(10, Math.floor(Math.log10(Math.abs(step))));
        expect([1, 2, 5, 10], `the axis steps by ${step}, which is not a round interval`)
          .toContain(Math.round(magnitude));
      });
    }
  }
});

/**
 * COLOUR MEANS ONE THING ACROSS EVERY PACK THIS PLATFORM PRINTS.
 *
 * The two companies are chosen for their opposite books: the demo company
 * earns positive revenue and charges positive expenses, Brightsphere's
 * revenue is in net debit and its expenses in net credit. Under the old rule
 * — colour by the direction the step moved profit — the same two line classes
 * came out in opposite colours on the two sheets.
 */
describe('a line class takes one colour in every pack', () => {
  const labelled = (svg: string, index: number): string => bars(svg)[index]!.fill;

  it('draws revenue as an income line and operating expenses as a cost line, in both', () => {
    const demo = String(buildProfitWaterfallChart(demoSet, PACK_SCALE).svg);
    const bright = String(buildProfitWaterfallChart(brightsphereSet, PACK_SCALE).svg);

    // The fixtures are the reason this test can see anything: assert the
    // books really do run opposite ways before reading the colours off them.
    expect(demoSet.current.revenue).toBeGreaterThan(0);
    expect(brightsphereSet.current.revenue).toBeLessThan(0);
    expect(demoSet.current.operatingExpenses).toBeGreaterThan(0);
    expect(brightsphereSet.current.operatingExpenses).toBeLessThan(0);

    // Revenue is step 0 and Operating Expenses step 3 in `buildProfitWaterfall`.
    expect(labelled(demo, 0), 'demo revenue').toBe(DEFAULT_CHART_PALETTE.fav);
    expect(labelled(bright, 0), 'Brightsphere revenue').toBe(DEFAULT_CHART_PALETTE.fav);
    expect(labelled(demo, 3), 'demo operating expenses').toBe(DEFAULT_CHART_PALETTE.unfav);
    expect(labelled(bright, 3), 'Brightsphere operating expenses').toBe(DEFAULT_CHART_PALETTE.unfav);
  });
});
