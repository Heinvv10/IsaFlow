/**
 * The SSR chart path, tested on GEOMETRY rather than on labels.
 *
 * This repo has shipped a broken waterfall twice. Both implementations were
 * a transparent base bar plus a stacked movement bar; ECharts stacks
 * positive and negative values independently, so a movement from +400,000 to
 * −400,000 drew as a single oversized bar sitting entirely ABOVE the axis
 * instead of a bar that crosses it. Every fixture in both suites was
 * profit-positive, so both suites were green. The only thing that caught it
 * was rendering through SSR and reading the rect coordinates — which is what
 * these tests do, permanently.
 *
 * Of the geometry assertions below, exactly ONE catches that bug: `spans a
 * zero-crossing movement from its start to its end`. Reproduced against a
 * stacked-bar build, the count, subtotal and opex assertions all pass. They
 * are worth keeping as a description of the shape, but if these tests are
 * ever trimmed, the zero-crossing one is the one that must survive.
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
 * The y of the value axis's ZERO tick, read from the axis label rather than
 * from any bar. Anchoring the zero line to a bar's own edge makes the
 * "revenue is above zero" assertion circular — it reduces to "this rect has
 * positive height" and cannot fail. `formatMoney(0)` renders as an en dash,
 * and the axis label carries its baseline in a `translate()`.
 */
function zeroLineY(svg: string): number {
  const match = /<text\b[^>]*\btransform="translate\([\d.]+ ([\d.]+)\)"[^>]*>\u2013<\/text>/.exec(svg);
  expect(match, 'no zero tick label found on the value axis').not.toBeNull();
  return Number(match![1]);
}

/**
 * Every generated id and class name in the SVG. zrender namespaces these per
 * chart; a pack page inlines several charts into one document, so two charts
 * sharing an id means one `url(#...)` clip resolves to the wrong rect.
 */
function idsAndClasses(svg: string): Set<string> {
  const names = new Set<string>();
  for (const m of svg.matchAll(/(?:\bid="|\bclass="|url\(#)([^")]+)/g)) names.add(m[1]!);
  return names;
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

  it('refuses to return an SVG that would fetch something', () => {
    // ADVERSARIAL: a per-datum `symbol: 'image://…'` makes ECharts emit
    // `<image href="https://…">`. No option builder on this branch sets
    // `symbol` from data, so it is not reachable today — but renderChartSvg
    // takes `unknown`, and this string is inlined into documents sent to
    // clients and banks. An outbound fetch from the PDF renderer is a
    // tracking beacon or an SSRF probe, so the render fails rather than
    // printing a chart that tried to call home.
    const hostile = {
      xAxis: { type: 'category', data: ['a', 'b'] },
      yAxis: { type: 'value' },
      series: [{
        type: 'line',
        data: [
          { value: 1, symbol: 'image://https://evil.example/beacon.png', symbolSize: 20 },
          { value: 2 },
        ],
      }],
    };
    expect(() => renderChartSvg(hostile, SIZE)).toThrow(/external reference|renderChartSvg/i);
  });

  it('renders a label that CONTAINS a URL — a label is data, not a reference', () => {
    // The guard had the same defect as the id rewrite it sits next to: it
    // matched a pattern anywhere in the string instead of where the pattern
    // means something. Customer and supplier names arrive from Sage and bank
    // imports; one containing a URL would have aborted an entire pack render
    // with an error pointing at security rather than at the data. A URL in a
    // text node fetches nothing.
    const label = 'https://acme.example/inv';
    const svg = renderChartSvg(
      buildWaterfallOption(
        LOSS_STEPS.map((step, i) => (i === 0 ? { ...step, label } : step)),
        DEFAULT_PALETTE,
      ),
      SIZE,
    );
    expect(svg).toContain(`>${label}<`);
  });

  it('renders every legitimate pack chart without tripping the guard', () => {
    const opt = buildWaterfallOption(LOSS_STEPS, DEFAULT_PALETTE);
    for (const heightMm of Object.values(CHART_HEIGHT_MM)) {
      expect(() => renderChartSvg(opt, { widthMm: 170, heightMm })).not.toThrow();
    }
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

  it('gives two different charts disjoint id and class names', () => {
    // A pack page inlines several charts into ONE document. If both emit
    // `<clipPath id="zr-1">`, `url(#zr-1)` resolves to whichever came first
    // and the taller chart's plot area is clipped to the shorter one's box.
    const opt = buildWaterfallOption(LOSS_STEPS, DEFAULT_PALETTE);
    const short = renderChartSvg(opt, { widthMm: 170, heightMm: CHART_HEIGHT_MM.inline });
    const tall = renderChartSvg(opt, { widthMm: 170, heightMm: CHART_HEIGHT_MM.full });
    const shortIds = idsAndClasses(short);
    const tallIds = idsAndClasses(tall);
    expect(shortIds.size).toBeGreaterThan(0);
    expect([...shortIds].filter((name) => tallIds.has(name))).toEqual([]);
  });

  it('gives two charts of the same size but different content disjoint ids', () => {
    // Height is not the only thing that distinguishes two charts on a page.
    // A whole-document rewrite normalises token-shaped text too, so two
    // charts differing only in a LABEL canonicalise to the same string, hash
    // identically, and collide.
    const relabel = (label: string) =>
      buildWaterfallOption(
        LOSS_STEPS.map((step, i) => (i === 0 ? { ...step, label } : step)),
        DEFAULT_PALETTE,
      );
    const a = renderChartSvg(relabel('zr0-cls-1'), SIZE);
    const b = renderChartSvg(relabel('zr0-cls-2'), SIZE);
    const aIds = idsAndClasses(a);
    expect(aIds.size).toBeGreaterThan(0);
    expect([...aIds].filter((name) => idsAndClasses(b).has(name))).toEqual([]);
  });

  it('leaves a url(#...) label alone — `url(#` needs no quote to match', () => {
    // ADVERSARIAL: the rewrite matched `url(#` anywhere, including inside text
    // content, and HTML escaping cannot keep it out — there is no quote to
    // escape. A label is ledger data: an account name, a cost centre, a
    // project code. This one came back as `>url(#zrc3a6ab0c-1)<`: the label
    // the client reads was not the label in their ledger.
    const label = 'url(#zr0-cls-0)';
    const svg = renderChartSvg(
      buildWaterfallOption(
        LOSS_STEPS.map((step, i) => (i === 0 ? { ...step, label } : step)),
        DEFAULT_PALETTE,
      ),
      SIZE,
    );
    expect(svg).toContain(`>${label}<`);
  });

  it('does not let a url(#...) label steer the id hash into a collision', () => {
    // The other half of the same defect. A label token entered the `order`
    // map, so it was normalised into the canonical form the hash is taken
    // over — two charts differing ONLY in such a label canonicalised
    // identically, hashed identically, and emitted the SAME id set. That is
    // exactly the collision stableIds exists to prevent.
    const relabel = (label: string) =>
      buildWaterfallOption(
        LOSS_STEPS.map((step, i) => (i === 0 ? { ...step, label } : step)),
        DEFAULT_PALETTE,
      );
    const a = renderChartSvg(relabel('url(#zr0-cls-0)'), SIZE);
    const b = renderChartSvg(relabel('url(#zr7-abc-9)'), SIZE);
    const aIds = idsAndClasses(a);
    expect(aIds.size).toBeGreaterThan(0);
    expect([...aIds].filter((name) => idsAndClasses(b).has(name))).toEqual([]);
  });

  it('leaves label text alone — a label is data, not a generated name', () => {
    // Account names, cost centres and project codes come through as labels.
    // A rewrite that reaches into text content prints the wrong figure's name.
    const label = 'Project zr0-cls-1 recovery';
    const svg = renderChartSvg(
      buildWaterfallOption(
        LOSS_STEPS.map((step, i) => (i === 0 ? { ...step, label } : step)),
        DEFAULT_PALETTE,
      ),
      SIZE,
    );
    expect(svg).toContain(`>${label}<`);
  });

  describe('waterfall geometry (SVG y grows DOWNWARD — larger y is lower)', () => {
    const svg = renderChartSvg(buildWaterfallOption(LOSS_STEPS, DEFAULT_PALETTE), SIZE);
    const bars = parseBars(svg);
    const zeroY = zeroLineY(svg);

    it('draws one bar per step', () => {
      expect(bars).toHaveLength(LOSS_STEPS.length);
    });

    it('draws the revenue bar above the zero line, standing on it', () => {
      const revenue = bars[0]!;
      expect(revenue.top).toBeLessThan(zeroY);
      expect(revenue.bottom).toBeCloseTo(zeroY, 0); // runs 0 → +1,000,000
    });

    it('draws the loss subtotals BELOW the zero line', () => {
      const grossLoss = bars[2]!;
      const netLoss = bars[4]!;
      expect(grossLoss.top).toBeCloseTo(zeroY, 0);
      expect(grossLoss.bottom).toBeGreaterThan(zeroY);
      expect(netLoss.top).toBeCloseTo(zeroY, 0);
      expect(netLoss.bottom).toBeGreaterThan(zeroY);
      // 600,000 of loss must draw 1.5× the depth of 400,000 of loss.
      expect(netLoss.height / grossLoss.height).toBeCloseTo(1.5, 1);
    });

    // LOAD-BEARING. This is the ONLY assertion in the file that fails against
    // the stacked-bar waterfall this repo shipped twice; every other test here
    // passes against it. If these tests are ever trimmed, keep this one.
    it('spans a zero-crossing movement from its start to its end', () => {
      const costOfSales = bars[1]!;
      // Starts at +1,000,000 — level with the top of the revenue bar…
      expect(costOfSales.top).toBeCloseTo(bars[0]!.top, 0);
      // …and ends at −400,000, i.e. BELOW the axis. The stacked-bar bug drew
      // this as a single 1,400,000-tall bar sitting entirely above zero.
      expect(costOfSales.bottom).toBeGreaterThan(zeroY);
      expect(costOfSales.bottom).toBeCloseTo(bars[2]!.bottom, 0);
    });

    it('draws the operating-expense step entirely below zero, hanging off the gross loss', () => {
      const opex = bars[3]!;
      expect(opex.top).toBeGreaterThan(zeroY);
      expect(opex.top).toBeCloseTo(bars[2]!.bottom, 0); // starts where gross loss ends
      expect(opex.bottom).toBeCloseTo(bars[4]!.bottom, 0); // ends where net loss ends
    });
  });
});
