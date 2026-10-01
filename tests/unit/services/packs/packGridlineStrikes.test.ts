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
 * it is that no label anywhere in either pack is crossed by a rule — a
 * gridline or the axis line — it does not have something opaque under, across
 * the whole figure: its bar, or a paper ground.
 *
 * A HALO IS NOT THAT. For two rounds a figure outside its bar carried only a
 * paper stroke on its glyphs, and this test took the stroke's presence as
 * cover. It reaches two pixels from each glyph; the gap at a thousands
 * separator is nearer five. The management pack printed the (1 500 000)
 * gridline through "1 430 581" and "(1 329 181)" between every group of
 * digits. So cover is geometry again — a rectangle across the figure — and
 * the management pack's own bridge, in its theme, is held to it too.
 *
 * MEASURED OFF THE COMPOSED SVG, which is the only place this exists: the
 * option is right, the figures are right, and what was wrong is what the
 * renderer put where.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { FIGURE_HALO_PX } from '@/modules/accounting/services/packs/packWaterfallPlace';
import { LEGACY_WATERFALL_BOX } from '@/components/accounting/packs/PackSectionView';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { DEMO_MANAGEMENT_BRIDGE, renderLegacyBridge } from './support/legacyBridge';
import { glyphCells } from './support/bridgeSvg';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

const PAPER = DEFAULT_CHART_PALETTE.paper.toLowerCase();

/** A full-width horizontal rule the axis draws, in the SVG's own units. */
interface Gridline { y: number; x1: number; x2: number }

/** One `<path>` zrender emits for a rect — the bar, or the ground under a
 *  label. `M x yl w 0l0 h l-w 0Z`. */
interface Rect { x: number; y: number; w: number; h: number; fill: string }

interface Label { text: string; cx: number; cy: number; ground: Rect[]; halo: { colour: string; width: number } | null }

/** Any horizontal rule: a gridline, or the axis line at zero. */
const GRID = /<path d="M([-\d.]+) ([-\d.]+)L([-\d.]+) \2"[^>]*stroke="#[0-9a-f]{6}"/gi;
const RECT = /<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)l[-\d.]+ 0Z"[^>]*fill="(#[0-9a-f]{6})"/gi;
const TEXT = /<text\b[^>]*\bx="([-\d.]+)"\s+y="([-\d.]+)"([^>]*)>([^<]*)<\/text>/gi;


/** The line box a 12px label occupies, by the face's own advances — not a
 *  ruler production sizes the ground with. */
const LABEL_PX = 12;
const labelWidth = (text: string): number => { const cells = glyphCells(text, 0); return cells[cells.length - 1]!.right - cells[0]!.left; };

function gridlines(svg: string): Gridline[] {
  return [...svg.matchAll(GRID)].map((m) => ({
    y: Number(m[2]), x1: Math.min(Number(m[1]), Number(m[3])), x2: Math.max(Number(m[1]), Number(m[3])),
  }));
}

/**
 * Every bar label, with every rect painted before it — the bars and grounds,
 * which the renderer paints under all the figures — and its own halo.
 */
function labels(svg: string): Label[] {
  const plot = svg.slice(svg.indexOf('clip-path'));
  const marks = [...plot.matchAll(RECT)].map((m) => ({
    at: m.index, rect: { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), fill: m[5]!.toLowerCase() },
  }));
  const texts = [...plot.matchAll(TEXT)].map((m) => ({
    at: m.index, text: m[4] ?? '', cx: Number(m[1]), cy: Number(m[2]),
    fill: /\bfill="([^"]+)"/i.exec(m[3]!)?.[1]?.toLowerCase() ?? '',
    stroke: /\bstroke="(#[0-9a-f]{6})"/i.exec(m[3]!)?.[1]?.toLowerCase(),
    width: Number(/\bstroke-width="([\d.]+)"/.exec(m[3]!)?.[1] ?? 0),
  }));
  // The halo is a pass of its own: the same text at the same place, stroked
  // and unfilled, painted BEFORE the figure — under every figure's fill.
  return texts.filter((t) => t.fill !== 'none').map((t) => {
    const halo = texts.find((h) => h.fill === 'none' && h.at < t.at && h.text === t.text && h.cx === t.cx && h.cy === t.cy && h.stroke !== undefined);
    return {
      text: t.text, cx: t.cx, cy: t.cy,
      ground: marks.filter((r) => r.at < t.at).map((r) => r.rect),
      halo: halo === undefined ? null : { colour: halo.stroke!, width: halo.width },
    };
  });
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

/** Every crossing of a figure by a rule, and the ones with nothing behind them. */
function strikes(svg: string): { crossed: string[]; bare: string[] } {
  const rules = gridlines(svg);
  expect(rules.length, 'no rules parsed, so nothing is being checked').toBeGreaterThan(0);
  const crossed: string[] = [];
  const bare: string[] = [];
  for (const label of labels(svg)) {
    const half = labelWidth(label.text) / 2;
    const box = { left: label.cx - half, right: label.cx + half, top: label.cy - LABEL_PX / 2, bottom: label.cy + LABEL_PX / 2 };
    for (const rule of rules) {
      if (!(rule.y > box.top && rule.y < box.bottom && rule.x1 < box.right && rule.x2 > box.left)) continue;
      crossed.push(label.text);
      // SOMETHING OPAQUE, ACROSS THE WHOLE FIGURE. A ground that covers part
      // of the label leaves the rule running out of one side of it, which
      // is the same strike in a smaller place.
      const covered = label.ground.some((r) => r.y <= rule.y && r.y + r.h >= rule.y && r.x <= box.left && r.x + r.w >= box.right);
      if (!covered) bare.push(`the rule at y=${rule.y} runs through "${label.text}" (${box.left.toFixed(1)} to ${box.right.toFixed(1)}) with nothing behind it`);
    }
  }
  return { crossed, bare };
}

describe('no gridline is drawn through a figure', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`leaves every bridge label on ${company} an unbroken ground`, () => {
      const all = bridges(input).map((bridge) => ({ page: bridge.page, ...strikes(bridge.svg) }));
      expect(all.flatMap((b) => b.bare.map((s) => `${b.page}: ${s}`))).toEqual([]);
      // NOT VACUOUS. A parser that finds no crossing passes this file
      // silently, and every regex here is reading a renderer's output.
      expect(all.flatMap((b) => b.crossed).length, `${company}: no label is crossed by a rule at all`).toBeGreaterThan(0);
    });
  }

  it('is reading the strike the gate found: Brightsphere sheet 6, the (411) label', () => {
    const sheet = bridges(brightsphereLiveInput).find((b) => b.page === 'Income statement')!;
    const label = labels(sheet.svg).find((l) => l.text === '(411)');
    expect(label, 'sheet 6 no longer prints the label this test was written for').toBeDefined();
    expect(strikes(sheet.svg).crossed, 'no rule crosses (411) any more, so the fix is not being tested here').toContain('(411)');
    // And it is a PAPER ground rather than the bar: this label sits clear of
    // its own bar, which is the half of the defect paint order does not save.
    const half = labelWidth(label!.text) / 2;
    expect(label!.ground.some((r) => r.fill === PAPER && r.x <= label!.cx - half && r.x + r.w >= label!.cx + half)).toBe(true);
    // The halo is still there, at the width the collision rule assumes.
    expect(label!.halo).toEqual({ colour: PAPER, width: FIGURE_HALO_PX });
  });

  it('the management pack\'s Demo bridge, in its own theme: the rule under "1 430 581" and "(1 329 181)" is covered', () => {
    const svg = renderLegacyBridge(DEMO_MANAGEMENT_BRIDGE, LEGACY_WATERFALL_BOX.widthPx, LEGACY_WATERFALL_BOX.heightPx);
    const { crossed, bare } = strikes(svg);
    const plain = crossed.map((t) => t.replace(/\s/g, ' '));
    expect(plain).toContain('1 430 581');
    expect(plain).toContain('(1 329 181)');
    expect(bare).toEqual([]);
  });
});
