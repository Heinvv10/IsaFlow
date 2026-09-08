/**
 * A GRIDLINE MAY NOT RUN THROUGH A FIGURE ON A BRIDGE.
 *
 * A blind visual gate, re-run against a stripped clean-room copy of the
 * render, found the only visible strike in twenty-four sheets: Brightsphere's
 * sheet 6 drew the `(1 000)` gridline — y 397.1pt, running the full width of
 * the plot from 111.1 to 544.4 — straight through the `(411)` label at
 * 440.6, 389.6 to 462.4, 401.3. At 500dpi the rule cuts the bottom of both
 * parentheses. The label had nothing behind it.
 *
 * THE DEMO'S NEAR-MISS IS WHY THIS IS A RULE AND NOT A NUDGE. `1 431` sits
 * 382.2 to 393.9 against the zero line at 391.1 — a rule straight through it
 * — and it is invisible only because that label sits INSIDE its bar and the
 * bar is painted over the gridline. The same picture is saved by paint order
 * on one company and struck on the other, off a difference of a few pixels of
 * bar height. So the assertion below is not "Brightsphere's (411) is clear";
 * it is that no label anywhere in either pack is crossed by a rule it does
 * not have an opaque ground under.
 *
 * MEASURED OFF THE COMPOSED SVG, which is the only place this exists: the
 * option is right, the figures are right, and what was wrong is what the
 * renderer put where.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

/** A full-width horizontal rule the axis draws, in the SVG's own units. */
interface Gridline { y: number; x1: number; x2: number }

/** One `<path>` zrender emits for a rect — the bar, or the ground under a
 *  label. `M x yl w 0l0 h l-w 0Z`. */
interface Rect { x: number; y: number; w: number; h: number; fill: string }

interface Label { text: string; cx: number; cy: number; ground: Rect[] }

const GRID = new RegExp(
  `<path d="M([-\\d.]+) ([-\\d.]+)L([-\\d.]+) \\2"[^>]*stroke="${DEFAULT_CHART_PALETTE.prior}"`,
  'gi',
);
const RECT = /<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)l[-\d.]+ 0Z"[^>]*fill="(#[0-9a-f]{6})"/gi;
const TEXT = /<text\b[^>]*\bx="([-\d.]+)"\s+y="([-\d.]+)"[^>]*>([^<]*)<\/text>/gi;

/** The line box a 12px label occupies — the size `renderItem` sets its ground
 *  from, and the same em table the page composer measures prose with. */
const LABEL_PX = 12;
const labelWidth = (text: string): number => textWidthEms(text) * LABEL_PX;

function gridlines(svg: string): Gridline[] {
  return [...svg.matchAll(GRID)].map((m) => ({
    y: Number(m[2]), x1: Math.min(Number(m[1]), Number(m[3])), x2: Math.max(Number(m[1]), Number(m[3])),
  }));
}

/**
 * Every bar label, with the rects drawn before it and after the previous
 * label — its own group's ground and its own bar.
 *
 * Document order is the pairing, the same one `packWaterfallLegibility` uses:
 * `renderItem` emits one group per step and nothing interleaves them.
 */
function labels(svg: string): Label[] {
  const plot = svg.slice(svg.indexOf('clip-path'));
  const marks = [...plot.matchAll(RECT)].map((m) => ({
    at: m.index, rect: { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), fill: m[5]!.toLowerCase() },
  }));
  const out: Label[] = [];
  let from = 0;
  for (const m of plot.matchAll(TEXT)) {
    const at = m.index;
    out.push({
      text: m[3] ?? '',
      cx: Number(m[1]),
      cy: Number(m[2]),
      ground: marks.filter((r) => r.at > from && r.at < at).map((r) => r.rect),
    });
    from = at;
  }
  return out;
}

/** Every waterfall the pack composes, by sheet. */
function bridges(input: BoardPackInput): Array<{ page: string; title: string; svg: string }> {
  const out: Array<{ page: string; title: string; svg: string }> = [];
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'chart' || block.chart.kind !== 'waterfall') continue;
      out.push({ page: page.navLabel, title: block.chart.title, svg: block.chart.svg });
    }
  }
  return out;
}

describe('no gridline is drawn through a figure', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`leaves every bridge label on ${company} an unbroken ground`, () => {
      let checked = 0;
      for (const bridge of bridges(input)) {
        const rules = gridlines(bridge.svg);
        expect(rules.length, `${bridge.page}: no gridlines parsed, so nothing is being checked`)
          .toBeGreaterThan(0);
        for (const label of labels(bridge.svg)) {
          const half = labelWidth(label.text) / 2;
          const box = {
            left: label.cx - half, right: label.cx + half,
            top: label.cy - LABEL_PX / 2, bottom: label.cy + LABEL_PX / 2,
          };
          for (const rule of rules) {
            const crosses = rule.y > box.top && rule.y < box.bottom
              && rule.x1 < box.right && rule.x2 > box.left;
            if (!crosses) continue;
            checked += 1;
            // SOMETHING OPAQUE, ACROSS THE WHOLE FIGURE. A ground that covers
            // part of the label leaves the rule running out of one side of
            // it, which is the same strike in a smaller place.
            const covered = label.ground.some((r) => r.y <= rule.y && r.y + r.h >= rule.y
              && r.x <= box.left && r.x + r.w >= box.right);
            expect(
              covered,
              `${company} ${bridge.page}: the gridline at y=${rule.y} runs through "${label.text}" `
                + `(${box.left.toFixed(1)}, ${box.top.toFixed(1)} to ${box.right.toFixed(1)}, `
                + `${box.bottom.toFixed(1)}) with nothing behind it`,
            ).toBe(true);
          }
        }
      }
      // NOT VACUOUS. A parser that finds no crossing passes this file
      // silently, and every regex here is reading a renderer's output.
      expect(checked, `${company}: no label is crossed by a rule at all — the check found nothing`)
        .toBeGreaterThan(0);
    });
  }

  it('is reading the strike the gate found: Brightsphere sheet 6, the (411) label', () => {
    const sheet = bridges(brightsphereLiveInput).find((b) => b.page === 'Income statement')!;
    const label = labels(sheet.svg).find((l) => l.text === '(411)');
    expect(label, 'sheet 6 no longer prints the label this test was written for').toBeDefined();
    const half = labelWidth(label!.text) / 2;
    const struck = gridlines(sheet.svg).filter((r) => r.y > label!.cy - LABEL_PX / 2
      && r.y < label!.cy + LABEL_PX / 2
      && r.x1 < label!.cx + half && r.x2 > label!.cx - half);
    expect(struck.length, 'no rule crosses (411) any more, so the fix is not being tested here')
      .toBeGreaterThan(0);
    // And it is a PAPER ground rather than the bar: this label sits clear of
    // its own bar, which is the half of the defect paint order does not save.
    expect(label!.ground.some((r) => r.fill === DEFAULT_CHART_PALETTE.paper.toLowerCase())).toBe(true);
  });
});
