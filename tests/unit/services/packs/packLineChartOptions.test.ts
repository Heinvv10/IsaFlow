/**
 * The page-3 sparkline and page-10 small multiples, asserted STRUCTURALLY.
 *
 * Both were previously drawn by `trendOption` — a bar chart with a full axis
 * frame — while page 10's `PackChartSpec.kind` claimed 'line' and spec §4.A
 * page 3 asked for a sparkline with no axes. The only chart assertion in the
 * suite was `svg.length > 0`, which a bar chart, a line chart and an empty
 * frame all satisfy equally. These read the option instead.
 */
import { describe, expect, it } from 'vitest';
import { buildCashTrendChart, buildTrendPanels } from '@/modules/accounting/services/packs/pages/packPageCharts';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { formatMoney } from '@/lib/format/money';
import {
  sharedDomain,
  smallMultipleOption,
  sparklineOption,
} from '@/modules/accounting/services/packs/packLineChartOptions';

/** The line series' own path — distinguished from grid/axis lines by the
 *  ink stroke and width `smallMultipleOption` gives it. */
function seriesPath(svg: string): string {
  const match = svg.match(/<path d="([^"]+)"[^>]*stroke="#15202b" stroke-width="2"/);
  if (!match) throw new Error('no series path found in SVG');
  return match[1]!;
}

/** Number of plotted points in a line series path — an M plus N-1 Ls. */
function pointCount(path: string): number {
  return path.split(/[ML]/).filter((s) => s.trim() !== '').length;
}

interface AxisLike { show?: boolean; min?: number; max?: number }
interface SeriesLike { type?: string; endLabel?: { show?: boolean }; showSymbol?: boolean; data?: unknown[] }
interface OptionLike {
  legend?: unknown;
  xAxis?: AxisLike;
  yAxis?: AxisLike;
  series?: SeriesLike[];
}

const points = [
  { label: 'M1', value: 100 },
  { label: 'M2', value: 140 },
  { label: 'M3', value: 90 },
];

describe('sparklineOption', () => {
  const option = sparklineOption(points) as OptionLike;

  it('draws a line, not a bar', () => {
    expect(option.series?.[0]?.type).toBe('line');
  });

  it('shows no axes at all — spec §4.A page 3 says sparkline, not chart', () => {
    expect(option.xAxis?.show).toBe(false);
    expect(option.yAxis?.show).toBe(false);
  });

  it('carries no legend', () => {
    expect(option.legend).toBeUndefined();
  });
});

describe('smallMultipleOption', () => {
  const domain = { min: 0, max: 200 };
  const option = smallMultipleOption(points, domain) as OptionLike;

  it('draws a line, not a bar', () => {
    expect(option.series?.[0]?.type).toBe('line');
  });

  it('labels the end of the series directly instead of carrying a legend', () => {
    expect(option.series?.[0]?.endLabel?.show).toBe(true);
    expect(option.legend).toBeUndefined();
  });

  it('takes the y-scale it is GIVEN, so a row of panels shares one', () => {
    // The failure this pins: a panel that scaled to its own series draws a
    // flat metric and a collapsing one with the same apparent slope.
    expect(option.yAxis?.min).toBe(0);
    expect(option.yAxis?.max).toBe(200);
    const other = smallMultipleOption([{ label: 'M1', value: 5 }], domain) as OptionLike;
    expect(other.yAxis?.min).toBe(option.yAxis?.min);
    expect(other.yAxis?.max).toBe(option.yAxis?.max);
  });
});

describe('sharedDomain', () => {
  it('spans every series in the row', () => {
    expect(sharedDomain([[10, 20], [-50, 5]])).toEqual({ min: -50, max: 20 });
  });

  it('always includes zero, so a reader can see which side of break-even a panel sits on', () => {
    expect(sharedDomain([[10, 20]]).min).toBe(0);
    expect(sharedDomain([[-10, -20]]).max).toBe(0);
  });
});


describe('buildTrendPanels — the row actually shares one scale', () => {
  // Two series with the SAME SHAPE and different levels: revenue is exactly
  // ten times net profit at every point. Under one shared y-scale the two
  // lines sit at different heights and their SVGs differ. Under a per-panel
  // scale each series is normalised to its own extent, so both panels draw
  // the identical path — which is a page telling a director that a metric
  // ten times smaller moved just as much. Asserting the OPTION honours a
  // domain is not enough; this asserts the CALLER passes one domain.
  const trend: PackTrendPoint[] = [10, 14, 9, 16].map((v, i) => ({
    month: `2026-0${i + 1}`,
    label: `M${i + 1}`,
    revenue: v * 100_000,
    expenses: v * 10_000,
    netProfit: v * 10_000,
    costOfSales: v * 50_000,
    operatingExpenses: v * 10_000,
    grossMarginPct: 50,
    cash: v * 20_000,
    accountsReceivable: v * 5_000,
    debtorDays: 30,
  }));

  it('draws two same-shaped series at different heights', () => {
    const panels = buildTrendPanels(trend).panels;
    const revenue = panels.find((p) => p.id === 'trend-revenue')!;
    const netProfit = panels.find((p) => p.id === 'trend-net-profit')!;
    const paths = (svg: string): string[] => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);
    expect(paths(revenue.svg).length).toBeGreaterThan(0);
    expect(paths(revenue.svg)).not.toEqual(paths(netProfit.svg));
  });

  it('draws every panel as a line spec', () => {
    expect(buildTrendPanels(trend).panels.every((p) => p.kind === 'line')).toBe(true);
  });
});

/**
 * Page 8's closing-cash line — the deliverable this task exists to make
 * possible. Asserted structurally: point count, the closing value the chart
 * itself labels, and that a different series draws a different path — not
 * `svg.length > 0`, which a bar chart, a line chart and an empty frame all
 * satisfy equally (the exact defect this test file's header exists to stop).
 */
describe('buildCashTrendChart', () => {
  const makeTrend = (cash: number[]): PackTrendPoint[] => cash.map((v, i) => ({
    month: `2026-0${i + 1}`,
    label: `M${i + 1}`,
    revenue: 100_000, expenses: 60_000, netProfit: 40_000,
    costOfSales: 30_000, operatingExpenses: 30_000, grossMarginPct: 70,
    cash: v, accountsReceivable: 20_000, debtorDays: 6,
  }));

  it('returns null when there is no trend series to plot', () => {
    expect(buildCashTrendChart([])).toBeNull();
  });

  it('is a line chart with one point per trend period', () => {
    const trend = makeTrend([500_000, 520_000, 480_000, 610_000]);
    const chart = buildCashTrendChart(trend)!;
    expect(chart.kind).toBe('line');
    expect(pointCount(seriesPath(chart.svg))).toBe(trend.length);
  });

  it('labels the closing value the chart actually draws', () => {
    const trend = makeTrend([500_000, 520_000, 480_000, 610_000]);
    const chart = buildCashTrendChart(trend)!;
    expect(chart.svg).toContain(formatMoney(610_000));
  });

  it('draws a different path when the cash series is different', () => {
    const rising = buildCashTrendChart(makeTrend([500_000, 520_000, 480_000, 610_000]))!;
    const falling = buildCashTrendChart(makeTrend([610_000, 480_000, 520_000, 500_000]))!;
    expect(seriesPath(rising.svg)).not.toBe(seriesPath(falling.svg));
  });
});
