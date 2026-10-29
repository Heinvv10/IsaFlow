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

interface Painted { text: string; x: number; size: number; family: string; anchor: string }

function texts(svg: string): Painted[] {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attrs = m[1] ?? '';
    return {
      text: (m[2] ?? '').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
      x: Number(/transform="translate\(([-\d.]+) /.exec(attrs)?.[1] ?? NaN),
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

const WIDTHS = [1280, 390];
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
