/**
 * CAN A DIRECTOR READ THE Y-AXIS?
 *
 * Page 7's composition bar steps down a rung when total assets are negative,
 * to make room for the disclosure that says so. The first version of that
 * step-down went to the BOTTOM rung — 48mm — and on the live demo figures,
 * whose axis runs 4 000 to (5 000), the eleven tick labels had about 7.7px
 * between their centres at a 12px font: `(1 000)`, `(2 000)` and `(3 000)`
 * printed on top of one another. The page still ended with a quarter-sheet of
 * white, so the height was never the page's to take.
 *
 * Overlapping axis labels are the visual signature of an unfinished chart,
 * and no test in the suite could see them: the sheet count passed, the model
 * was correct, and the chart is an opaque SVG string to every other check.
 *
 * This reads the SVG the pack actually carries and measures the gap between
 * neighbouring tick labels. It is not a proxy for the picture — the labels
 * ARE laid out at these coordinates, at this font size, and two of them
 * closer together than their own type is exactly what overprinting is.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  buildCashTrendChart,
  buildPositionCompositionChart,
  positionCompositionChartAtHeight,
  POSITION_CHART_FLOOR_MM,
} from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';
import { brightsphereSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoSet, liveDemoInput } from './fixtures/liveDemoBoardPack';
import { demoInput } from './fixtures/boardPackInputs';

/**
 * Every `<text>` in the SVG, as a font size and the y it is centred on.
 *
 * zrender emits the position in a `transform="translate(x y)"` and the size
 * in an inline `style`, so both come off the same element and neither is
 * assumed.
 */
interface Label { x: number; y: number; size: number; text: string }

function labels(svg: string): Label[] {
  const out: Label[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = match[1] ?? '';
    const position = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(attrs);
    const size = /font-size:([\d.]+)px/.exec(attrs);
    if (position === null || size === null) continue;
    out.push({
      x: Number(position[1]),
      y: Number(position[2]),
      size: Number(size[1]),
      text: (match[2] ?? '').replace(/&#39;/g, "'"),
    });
  }
  return out;
}

/**
 * The value-axis ticks: the labels sharing the x the axis draws them at.
 *
 * Picked by the column they occupy rather than by matching their text — the
 * axis formatter is `formatMoney`, so a tick reads `(3 000)` or `–` and a
 * text match would quietly select nothing the day the formatter changes,
 * which is a green test asserting an empty list.
 */
function yAxisTicks(svg: string): Label[] {
  const all = labels(svg);
  const byColumn = new Map<number, Label[]>();
  for (const label of all) {
    const column = byColumn.get(label.x) ?? [];
    column.push(label);
    byColumn.set(label.x, column);
  }
  const ticks = [...byColumn.values()].reduce((a, b) => (b.length > a.length ? b : a), []);
  return [...ticks].sort((a, b) => a.y - b.y);
}

/** The smallest distance between two neighbouring ticks' centres. */
function tightestGap(ticks: Label[]): number {
  let tightest = Infinity;
  for (let i = 1; i < ticks.length; i += 1) {
    tightest = Math.min(tightest, ticks[i]!.y - ticks[i - 1]!.y);
  }
  return tightest;
}

const CASES: Array<[string, typeof demoSet]> = [
  ['the live demo company (negative assets)', liveDemoSet],
  ['the demo company (positive assets)', demoSet],
  ['Brightsphere (positive assets, negative equity)', brightsphereSet],
];

describe("page 7's composition chart", () => {
  for (const [name, set] of CASES) {
    it(`prints a legible y-axis for ${name}`, () => {
      const chart = buildPositionCompositionChart(set, PACK_SCALE);
      const ticks = yAxisTicks(String(chart.svg));

      // Not vacuous: an axis with one tick has no gap to be too small.
      expect(ticks.length, 'no y-axis tick labels were found in the SVG').toBeGreaterThan(2);

      const size = ticks[0]!.size;
      const gap = tightestGap(ticks);
      expect(
        gap,
        `two tick labels are ${gap.toFixed(1)}px apart at ${size}px type — `
          + `${ticks.map((t) => t.text).join(' / ')}`,
      ).toBeGreaterThanOrEqual(size);
    });
  }

  /**
   * AND AT THE SHORTEST HEIGHT THE PAGE MAY TAKE IT TO. Page 7 hands the
   * chart whatever its sheet is short by — see `positionCompositionChartAtHeight`
   * — so the floor is the height this axis has to survive, not the rung.
   */
  for (const [name, set] of CASES) {
    it(`stays legible at the floor for ${name}`, () => {
      const chart = positionCompositionChartAtHeight(set, PACK_SCALE, POSITION_CHART_FLOOR_MM);
      expect(chart, 'the floor itself is a height the chart is drawn at').not.toBeNull();
      expect(chart!.heightMm).toBe(POSITION_CHART_FLOOR_MM);
      const ticks = yAxisTicks(String(chart!.svg));
      expect(ticks.length, 'no y-axis tick labels were found in the SVG').toBeGreaterThan(2);
      expect(tightestGap(ticks)).toBeGreaterThanOrEqual(ticks[0]!.size);
    });
  }

  /**
   * NOT OVERLAPPING IS NOT THE SAME AS LEGIBLE. The checks above pass a tick
   * column whose labels stand one type-size apart, which is labels TOUCHING:
   * the demo's sheet 7 printed 4 000 down to (5 000) at every 1 000, ten
   * labels in 135px, on the chart the page had shortened to 65mm. The tick
   * count has to come from the plot's height, so a shorter chart draws fewer
   * of them — half a type-size of air between neighbours at every height the
   * page can take the chart to.
   */
  const HEIGHTS: Array<[string, number]> = [
    ['the middle rung', CHART_HEIGHT_MM.half],
    ['the 65mm the live sheets take it to', 65],
    ['the floor', POSITION_CHART_FLOOR_MM],
  ];
  for (const [name, set] of CASES) {
    for (const [rung, heightMm] of HEIGHTS) {
      it(`keeps air between the ticks at ${rung} for ${name}`, () => {
        const chart = positionCompositionChartAtHeight(set, PACK_SCALE, heightMm)!;
        const ticks = yAxisTicks(String(chart.svg));
        expect(ticks.length, 'an axis needs its ends and something between').toBeGreaterThanOrEqual(3);
        const gap = tightestGap(ticks);
        expect(
          gap,
          `ticks ${gap.toFixed(1)}px apart at ${ticks[0]!.size}px type — ${ticks.map((t) => t.text).join(' / ')}`,
        ).toBeGreaterThanOrEqual(ticks[0]!.size * 1.5);
      });
    }
  }

  it('draws fewer ticks on the shorter chart, not the same ticks closer together', () => {
    const tall = yAxisTicks(String(positionCompositionChartAtHeight(liveDemoSet, PACK_SCALE, CHART_HEIGHT_MM.half)!.svg));
    const short = yAxisTicks(String(positionCompositionChartAtHeight(liveDemoSet, PACK_SCALE, POSITION_CHART_FLOOR_MM)!.svg));
    expect(short.length).toBeLessThanOrEqual(tall.length);
    // And the axis still contains its data: round bounds either side of zero.
    expect(short[0]!.text).not.toBe(short[short.length - 1]!.text);
  });

  it('refuses a height under the floor rather than drawing an axis that overprints', () => {
    expect(positionCompositionChartAtHeight(demoSet, PACK_SCALE, POSITION_CHART_FLOOR_MM - 1)).toBeNull();
  });

  /**
   * THE MIDDLE RUNG, ON EVERY COMPANY, AND NOT THE BOTTOM ONE.
   *
   * The gap check above is what matters to a reader, but it is satisfied by a
   * chart at ANY height that happens to space its ticks — so this pins the
   * other half. The height used to be `totalAssets < 0 ? MID : FULL`, which
   * made a page with a §3.5 disclosure shorter than one without and left
   * Brightsphere's sheet — positive assets, one disclosure — at the full rung
   * with 2.73mm of slack, too little for the trade-balances footnote page 7
   * now carries. Every company gets the middle rung, so the two balance
   * sheets are the same shape and the room is there whatever the sign of the
   * assets.
   *
   * Both directions are pinned: MID is not FULL (the room is actually given
   * back) and MID is not HALF (48mm is where three of this axis's tick
   * labels printed on top of one another).
   */
  it('draws on the middle rung whatever the sign of total assets', () => {
    expect(liveDemoSet.current.totalAssets, 'this fixture is the negative-assets case').toBeLessThan(0);
    expect(demoSet.current.totalAssets, 'and this one is not').toBeGreaterThan(0);

    for (const set of [liveDemoSet, demoSet, brightsphereSet]) {
      const height = buildPositionCompositionChart(set, PACK_SCALE).heightMm;
      expect(height).toBe(CHART_HEIGHT_MM.half);
      expect(height).toBeLessThan(CHART_HEIGHT_MM.full);
      expect(height).toBeGreaterThan(CHART_HEIGHT_MM.inline);
    }
  });
});

/**
 * PAGE 8'S CASH LINE IS THE ONLY PICTURE OF CASH IN THE PACK, AND IT HAD NO
 * SCALE ON IT.
 *
 * Six horizontal gridlines, not one numeric label, no unit named and no zero
 * reference; only the final point carried a value. A director could not tell
 * whether the trough was (600) or (6 000), or on which side of zero the line
 * sat — and on this company every month of it is below zero. The waterfall on
 * page 6 and the column chart on page 7 are both labelled, which made this
 * read as an unfinished panel rather than a choice.
 *
 * It is the SAME function page 10's panels use, and they are right to be
 * bare: an 83mm panel read for direction beside five others cannot carry
 * ticks. So this asserts the difference rather than the option — the full
 * width line has readable numbers on it, the 83mm panels do not.
 */
describe("page 8's closing-cash line", () => {
  for (const [name, input] of [['the live demo company', liveDemoInput], ['the demo company', demoInput]] as const) {
    it(`carries readable, non-overlapping tick labels for ${name}`, () => {
      const chart = buildCashTrendChart(input.trend, PACK_SCALE);
      expect(chart, 'this fixture draws a cash line').not.toBeNull();
      const ticks = yAxisTicks(String(chart!.svg));
      expect(ticks.length, 'no y-axis tick labels were found in the SVG').toBeGreaterThan(2);
      const gap = tightestGap(ticks);
      expect(gap, `ticks ${ticks.map((t) => t.text).join(' / ')}`).toBeGreaterThanOrEqual(ticks[0]!.size);
      // The unit, named on the axis rather than left to a caption a chart
      // away. Read through `labels`, which un-escapes the apostrophe the SVG
      // stores as an entity.
      expect(labels(String(chart!.svg)).map((l) => l.text)).toContain(PACK_SCALE);
    });
  }

  it('leaves page 10\'s 83mm panels bare, which is what they are for', () => {
    const doc = buildBoardPackPages(liveDemoInput);
    const trends = doc.pages.find((p) => p.navLabel === 'Trends');
    const panels = trends?.blocks.find((b) => b.kind === 'smallMultiples');
    expect(panels?.kind).toBe('smallMultiples');
    const panel = panels!.kind === 'smallMultiples' ? panels!.panels[0]! : null;
    expect(yAxisTicks(String(panel!.svg)).length).toBeLessThan(3);
  });

  /**
   * AND THE LOWEST VALUE LABEL IS NOT SITTING ON THE FIRST MONTH. A panel
   * prints its y-axis's two ends in 8px type to the left of the plot and its
   * first month in 12px under the plot's left edge, so the two overlap
   * horizontally — and stood 4px apart vertically: "(1 621)" on top of
   * "Oct 2025". The month label is set a value-label's own height below it.
   */
  it('keeps the bottom value label clear of the month under it on every panel', () => {
    const trends = buildBoardPackPages(liveDemoInput).pages.find((p) => p.navLabel === 'Trends');
    const block = trends?.blocks.find((b) => b.kind === 'smallMultiples');
    const panels = block?.kind === 'smallMultiples' ? block.panels : [];
    expect(panels.length).toBeGreaterThan(3);
    for (const panel of panels) {
      const svg = String(panel.svg);
      const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)?.[1]);
      const texts = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => {
        const attrs = m[1] ?? '';
        const at = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(attrs)!;
        return {
          anchor: /text-anchor="(\w+)"/.exec(attrs)?.[1],
          size: Number(/font-size:([\d.]+)px/.exec(attrs)![1]),
          // zrender centres the glyphs on `translate` plus an optional `y`.
          centre: Number(at[2]) + Number(/\sy="([-\d.]+)"/.exec(attrs)?.[1] ?? 0),
        };
      });
      const values = texts.filter((t) => t.anchor === 'end');
      const months = texts.filter((t) => t.anchor === 'middle');
      expect(values.length, panel.id).toBe(2);
      expect(months.length, panel.id).toBe(2);
      const lowest = values.reduce((a, b) => (b.centre > a.centre ? b : a));
      const month = months[0]!;
      const clear = (month.centre - month.size / 2) - (lowest.centre + lowest.size / 2);
      expect(clear, `${panel.id}: the value label ends ${clear.toFixed(1)}px above the month`)
        .toBeGreaterThanOrEqual(lowest.size);
      // And the month still prints inside the panel's own box.
      expect(month.centre + month.size / 2, panel.id).toBeLessThanOrEqual(height);
    }
  });
});
