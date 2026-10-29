/**
 * CAN A READER SEE THE HEATMAP'S ACCOUNT NAMES ON A PHONE? (budgets P3 §2.7)
 *
 * Painted, not modelled: the option is rendered by ECharts' SSR SVG renderer
 * at 1280 and 390 px (as `lib/charts/ssrSvg.renderChartSvg` does, without the
 * pack's markup grammar, which refuses the decal's <pattern>: this chart is a
 * screen chart, not a pack chart), and the y-axis labels
 * are read back off the SVG. Every label must be painted whole inside the
 * chart (its measured left edge at or right of 0), and the plot must keep at
 * least half the width: `containLabel` alone keeps a long name inside the box
 * by squeezing the cells to nothing, which is the failure on a 390 px screen.
 * Below NARROW_WIDTH the labels truncate; the full name is in the tooltip.
 * Names are seeded (3 seeds) with lengths up to 70 characters. Pattern:
 * packChartAxisLegibility / packWaterfallLegibility (memory: chart label
 * fixes need pixel tests).
 */
import { describe, expect, it } from 'vitest';
import { getWidth } from 'zrender/lib/contain/text';
import { echarts } from '@/lib/charts/echarts';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { buildVarianceHeatmapOption } from '@/components/accounting/charts/varianceHeatmapOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import type { TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
const WORDS = ['Repairs', 'and', 'maintenance', 'Telkom', 'fibre', 'backhaul', 'leases', 'Vodacom', 'subcontractor', 'labour', 'Gauteng', 'Western', 'Cape', 'travel', 'fuel'];

/** Deterministic names, 6 to 70 characters. */
function names(seed: number, n: number): string[] {
  let s = seed;
  const next = () => { s = (s * 1103515245 + 12345) % 2147483648; return s; };
  return Array.from({ length: n }, () => {
    const target = 6 + (next() % 65);
    let name = '';
    while (name.length < target) name += `${name ? ' ' : ''}${WORDS[next() % WORDS.length]}`;
    return name.slice(0, target).trim();
  });
}

function linesOf(seed: number): TrackingLine[] {
  return names(seed, 12).map((accountName, i) => ({
    accountId: `id-${i}`, accountCode: String(6000 + i * 10), accountName, accountType: 'expense', band: 'operating_expense',
    actual: 0, budget: 0, variance: (i + 1) * 100, variancePct: null, favourable: false,
    projected: 0, fyBudget: null, projVariance: null, projFavourable: null, unallocatedBudget: 0, budgetAboveFilter: false,
    monthly: MONTHS.map((month, k) => ({ month, actual: 100 + k, budget: k % 5 === 0 ? null : 100, variance: k % 5 === 0 ? null : k, favourable: k % 5 === 0 ? null : k % 2 === 0 })),
  }));
}

interface Painted { text: string; x: number; size: number; family: string; anchor: string; angle: number }

function texts(svg: string): Painted[] {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attrs = m[1] ?? '';
    return {
      text: (m[2] ?? '').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
      x: Number(/transform="translate\(([-\d.]+) /.exec(attrs)?.[1] ?? /transform="matrix\([^,]+,[^,]+,[^,]+,[^,]+,([-\d.]+),/.exec(attrs)?.[1] ?? NaN),
      angle: (() => {
        const m = /transform="matrix\(([-\d.]+),([-\d.]+),/.exec(attrs);
        return m ? Math.atan2(Number(m[2]), Number(m[1])) : 0;
      })(),
      size: Number(/font-size:([\d.]+)px/.exec(attrs)?.[1] ?? 12),
      family: /font-family:([^;"]+)/.exec(attrs)?.[1]?.trim() ?? 'sans-serif',
      anchor: /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? 'start',
    };
  });
}

/** The SVG ECharts paints at this size, the way `renderChartSvg` initialises it. */
function paint(option: unknown, width: number, height: number): string {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption({ textStyle: { fontFamily: PACK_FONT_STACK }, ...(option as Record<string, unknown>), animation: false });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

// 260: the chart's own width on a 390 px phone (page, card and frame padding; measured off the
// browser proof's 326 px card); 294 for a slightly wider phone.
const WIDTHS = [1280, 390, 294, 260];
const SEEDS = [7, 1009, 424242];

describe('heatmap account labels', () => {
  for (const seed of SEEDS) {
    for (const px of WIDTHS) {
      it(`are painted whole, and leave the plot half the width, at ${px}px (seed ${seed})`, () => {
        const lines = linesOf(seed);
        const option = buildVarianceHeatmapOption(lines, MONTHS, DEFAULT_PALETTE, { showAll: true })!;
        const rows = (option as { yAxis: { data: string[] } }).yAxis.data;
        const svg = paint(option, px, rows.length * 28 + 80);
        const width = Number(/<svg[^>]*width="([\d.]+)"/.exec(svg)?.[1]);
        expect(width).toBeGreaterThan(px - 2);

        // The y-axis labels are the end-anchored texts that open one of the row labels (whole or truncated).
        const labels = texts(svg).filter((t) => t.anchor === 'end' && rows.some((r) => r.startsWith(t.text.replace(/(\.\.\.|…)$/, ''))));
        expect(labels.length, 'no y-axis labels found').toBe(rows.length);
        for (const l of labels) {
          const left = l.x - getWidth(l.text, `${l.size}px ${l.family}`);
          expect(left, `"${l.text}" starts at ${left.toFixed(1)}px`).toBeGreaterThanOrEqual(0);
        }

        // The cells: the plot's left edge is the leftmost drawn cell.
        const cellXs = [...svg.matchAll(/<path d="M([-\d.]+) [-\d.]+l[^"]*"[^>]*ecmeta_series_index="0"/g)].map((m) => Number(m[1]));
        expect(cellXs.length).toBeGreaterThan(0);
        const plot = width - Math.min(...cellXs);
        expect(plot, `the plot keeps ${plot.toFixed(0)}px of ${width}px`).toBeGreaterThanOrEqual(width * 0.5);
      });
    }
  }

  it('the full name of a truncated label is in the tooltip', () => {
    const lines = linesOf(7);
    const option = buildVarianceHeatmapOption(lines, MONTHS, DEFAULT_PALETTE, { showAll: true })!;
    const fmt = (option as { tooltip: { formatter: (p: { dataIndex: number }) => string } }).tooltip.formatter;
    const longest = [...lines].sort((a, b) => b.accountName.length - a.accountName.length)[0]!;
    expect(longest.accountName.length).toBeGreaterThan(40);
    const data = (option as { series: Array<{ data: number[][] }> }).series[0]!.data;
    const tips = data.map((_, i) => fmt({ dataIndex: i }));
    expect(tips.some((t) => t.includes(longest.accountName))).toBe(true);
  });
});

describe('heatmap month labels (browser review r1 M3)', () => {
  // A whole 12-month year, the most columns a phone has to label.
  for (const px of WIDTHS) {
    it(`never overlap at ${px}px`, () => {
      const option = buildVarianceHeatmapOption(linesOf(7), MONTHS, DEFAULT_PALETTE, { inProgressMonth: '2026-10' })!;
      const months = (option as { xAxis: { data: string[] } }).xAxis.data;
      const svg = paint(option, px, 16 * 28 + 80);
      const painted = texts(svg).filter((t) => months.includes(t.text)).sort((a, b) => a.x - b.x);
      expect(painted.length, 'month labels painted').toBeGreaterThanOrEqual(Math.ceil(months.length / 2));
      for (let i = 1; i < painted.length; i++) {
        const [a, b] = [painted[i - 1]!, painted[i]!];
        const dx = b.x - a.x;
        // Parallel rotated labels clear each other when their perpendicular gap exceeds the font size;
        // level ones when the half-widths fit between their centres.
        const clear = Math.abs(a.angle) > 0.01
          ? dx * Math.abs(Math.sin(a.angle)) >= a.size
          : dx >= (getWidth(a.text, `${a.size}px ${a.family}`) + getWidth(b.text, `${b.size}px ${b.family}`)) / 2 + 2;
        expect(clear, `"${a.text}" and "${b.text}" ${dx.toFixed(1)}px apart at ${px}px`).toBe(true);
      }
    });
  }

  it('a narrow chart always labels the latest month, so the in-progress "*" is on the axis', () => {
    const option = buildVarianceHeatmapOption(linesOf(7), MONTHS.slice(0, 8), DEFAULT_PALETTE, { inProgressMonth: '2026-10' })!;
    const svg = paint(option, 260, 16 * 28 + 80);
    expect(texts(svg).map((t) => t.text)).toContain('Oct 26 *');
  });

  it('a narrow chart keeps at least 17 characters of an account name', () => {
    const option = buildVarianceHeatmapOption(linesOf(7), MONTHS, DEFAULT_PALETTE, { showAll: true })!;
    const rows = (option as { yAxis: { data: string[] } }).yAxis.data;
    const svg = paint(option, 294, rows.length * 28 + 80);
    const labels = texts(svg).filter((t) => t.anchor === 'end' && rows.some((r) => r.startsWith(t.text.replace(/(\.\.\.|…)$/, ''))));
    for (const l of labels) expect(l.text.replace(/(\.\.\.|…)$/, '').length, l.text).toBeGreaterThanOrEqual(Math.min(17, rows.find((r) => r.startsWith(l.text.replace(/(\.\.\.|…)$/, '')))!.length));
  });
});
