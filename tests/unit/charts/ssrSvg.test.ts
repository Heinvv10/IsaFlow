/**
 * The SSR chart path, tested on GEOMETRY rather than on labels.
 *
 * This repo has shipped a broken waterfall twice. Both implementations were
 * a transparent base bar plus a stacked movement bar; ECharts stacks
 * positive and negative values independently, so a movement from +400,000 to
 * −400,000 drew as an 800,000 bar entirely ABOVE the axis and a net-loss
 * subtotal drew above the zero line. Every fixture in both suites was
 * profit-positive, so both suites were green. The only thing that caught it
 * was rendering through SSR and reading the rect coordinates — which is what
 * these tests do, permanently.
 */
import { describe, expect, it } from 'vitest';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { buildWaterfallOption } from '@/components/accounting/charts/waterfallOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

/**
 * A period that goes NEGATIVE, in the real `WaterfallStep` shape: each step
 * carries its own `start` and `end`, which is what makes the geometry
 * checkable at all. Cost of sales crosses zero (1,000,000 → −400,000); both
 * the gross loss and the net loss are subtotals below the axis.
 */
const LOSS_STEPS: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 1_000_000, value: 1_000_000, isSubtotal: false, color: 'green' },
  { label: 'Cost of sales', start: 1_000_000, end: -400_000, value: -1_400_000, isSubtotal: false, color: 'red' },
  { label: 'Gross loss', start: 0, end: -400_000, value: -400_000, isSubtotal: true, color: 'teal' },
  { label: 'Operating expenses', start: -400_000, end: -600_000, value: -200_000, isSubtotal: false, color: 'red' },
  { label: 'Net loss', start: 0, end: -600_000, value: -600_000, isSubtotal: true, color: 'blue' },
];

const SIZE = { widthMm: 170, heightMm: CHART_HEIGHT_MM.half };

interface Box { top: number; bottom: number; left: number; height: number }

/**
 * The absolute points of an SVG path. zrender writes a rect as
 * `M x y l dx dy l dx dy l dx dy Z` — a MOVE in absolute coordinates
 * followed by RELATIVE line segments — so summing the deltas is the only way
 * to recover where the bar actually ends. Reading the raw numbers as
 * coordinate pairs, as an earlier version of this parser did, silently
 * reports every bar as starting at the axis top.
 */
function pathPoints(d: string): Array<{ x: number; y: number }> {
  const tokens = d.match(/[MmLlZz]|-?\d+(?:\.\d+)?/g) ?? [];
  const points: Array<{ x: number; y: number }> = [];
  let cmd = 'M';
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/^[MmLlZz]$/.test(token)) {
      cmd = token;
      i += 1;
      if (cmd === 'Z' || cmd === 'z') continue;
    }
    const a = Number(tokens[i]);
    const b = Number(tokens[i + 1]);
    i += 2;
    if (!Number.isFinite(a) || !Number.isFinite(b)) break;
    if (cmd === 'M' || cmd === 'L') {
      x = a;
      y = b;
    } else {
      x += a;
      y += b;
    }
    points.push({ x, y });
  }
  return points;
}

/**
 * The bars, left to right, from the rendered SVG.
 *
 * zrender emits a custom-series `rect` as a `<path>` filled with the bar
 * colour. Axis split lines are stroked paths with `fill="none"` and the
 * clip region is `fill="#000"`, so filtering on the three bar fills isolates
 * exactly the bars. A parser that matched nothing would make every assertion
 * below vacuously true, so `parseBars` asserts it found something and the
 * first test asserts the count is one per step.
 */
function parseBars(svg: string): Box[] {
  const fills = [DEFAULT_PALETTE.ink, DEFAULT_PALETTE.fav, DEFAULT_PALETTE.unfav];
  const boxes: Box[] = [];
  for (const match of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? '';
    const fill = /fill="([^"]+)"/.exec(attrs)?.[1];
    if (!fill || !fills.includes(fill)) continue;
    const d = /\bd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) continue;
    const points = pathPoints(d);
    if (points.length === 0) continue;
    const ys = points.map((p) => p.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    boxes.push({ top, bottom, left: Math.min(...points.map((p) => p.x)), height: bottom - top });
  }
  expect(boxes.length).toBeGreaterThan(0);
  return boxes.sort((a, b) => a.left - b.left);
}

describe('renderChartSvg', () => {
  it('returns an inline SVG with no script and no external reference', () => {
    const svg = renderChartSvg(buildWaterfallOption(LOSS_STEPS, DEFAULT_PALETTE), SIZE);
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<image\b/i);
    // No `href` at all: nothing to fetch, so nothing the print renderer can
    // be blocked on or leak a request to.
    expect(svg).not.toMatch(/\bhref=/i);
    // The only URLs allowed are the SVG/xlink namespace declarations, which
    // are never fetched.
    expect(svg.replace(/xmlns(:xlink)?="[^"]*"/g, '')).not.toMatch(/https?:\/\//);
  });

  it('is deterministic — the same option renders byte-identically', () => {
    const opt = buildWaterfallOption(LOSS_STEPS, DEFAULT_PALETTE);
    expect(renderChartSvg(opt, SIZE)).toBe(renderChartSvg(opt, SIZE));
  });

  it('sizes the viewport from millimetres at 96dpi', () => {
    const svg = renderChartSvg(buildWaterfallOption(LOSS_STEPS, DEFAULT_PALETTE), {
      widthMm: 170,
      heightMm: 72,
    });
    // 170mm ≈ 643px, 72mm ≈ 272px at 96dpi.
    expect(svg).toMatch(/width="643(\.\d+)?"/);
    expect(svg).toMatch(/height="272(\.\d+)?"/);
  });

  describe('waterfall geometry (SVG y grows DOWNWARD — larger y is lower)', () => {
    const svg = renderChartSvg(buildWaterfallOption(LOSS_STEPS, DEFAULT_PALETTE), SIZE);
    const bars = parseBars(svg);

    it('draws one bar per step', () => {
      expect(bars).toHaveLength(LOSS_STEPS.length);
    });

    it('draws the revenue bar above the zero line', () => {
      const [revenue] = bars;
      const zeroY = revenue!.bottom; // Revenue runs 0 → +1,000,000, so its foot IS zero.
      expect(revenue!.top).toBeLessThan(zeroY);
      expect(revenue!.height).toBeGreaterThan(0);
    });

    it('draws the loss subtotals BELOW the zero line', () => {
      const zeroY = bars[0]!.bottom;
      const grossLoss = bars[2]!;
      const netLoss = bars[4]!;
      // A stacked-bar waterfall drew both of these ABOVE the axis.
      expect(grossLoss.top).toBeCloseTo(zeroY, 0);
      expect(grossLoss.bottom).toBeGreaterThan(zeroY);
      expect(netLoss.top).toBeCloseTo(zeroY, 0);
      expect(netLoss.bottom).toBeGreaterThan(zeroY);
      // 600,000 of loss must draw 1.5× the depth of 400,000 of loss.
      expect(netLoss.height / grossLoss.height).toBeCloseTo(1.5, 1);
    });

    it('spans a zero-crossing movement from its start to its end', () => {
      const zeroY = bars[0]!.bottom;
      const costOfSales = bars[1]!;
      // Starts at +1,000,000 — level with the top of the revenue bar…
      expect(costOfSales.top).toBeCloseTo(bars[0]!.top, 0);
      // …and ends at −400,000, i.e. BELOW the axis. The stacked-bar bug drew
      // this as a single 1,400,000-tall bar sitting entirely above zero.
      expect(costOfSales.bottom).toBeGreaterThan(zeroY);
      expect(costOfSales.bottom).toBeCloseTo(bars[2]!.bottom, 0);
    });

    it('draws the operating-expense step entirely below zero, hanging off the gross loss', () => {
      const zeroY = bars[0]!.bottom;
      const opex = bars[3]!;
      expect(opex.top).toBeGreaterThan(zeroY);
      expect(opex.top).toBeCloseTo(bars[2]!.bottom, 0); // starts where gross loss ends
      expect(opex.bottom).toBeCloseTo(bars[4]!.bottom, 0); // ends where net loss ends
    });
  });
});
