import { describe, it, expect } from 'vitest';
import { waterfallOption, trendOption, DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type {
  CustomSeriesRenderItem,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
} from 'echarts';

const steps: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 1000, value: 1000, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: 1000, end: 600, value: -400, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: 600, value: 600, isSubtotal: true, color: 'teal' },
];

interface CustomSeries { type: string; renderItem: CustomSeriesRenderItem; data: Array<[number, number]> }
interface TooltipFormatterOption {
  tooltip: { formatter: (params: { dataIndex: number } | Array<{ dataIndex: number }>) => string };
}

/** A pixel mapping simple enough to reason about by hand: y = ZERO_Y - value *
 *  SCALE, so a positive value sits above the zero line (smaller y, as SVG y
 *  grows downward) and a negative value sits below it. Matches how ECharts'
 *  real coordinate system behaves for a value axis without asserting any of
 *  ECharts' own internals. */
const ZERO_Y = 500;
const SCALE = 0.001;

function fakeApi(): CustomSeriesRenderItemAPI {
  return {
    coord: (data: number[]) => [Number(data[0]) * 40, ZERO_Y - Number(data[1]) * SCALE],
    size: () => [30, 0],
  } as unknown as CustomSeriesRenderItemAPI;
}

function renderRect(series: CustomSeries, dataIndex: number): { x: number; y: number; width: number; height: number } {
  const params = { dataIndex } as unknown as CustomSeriesRenderItemParams;
  const result = series.renderItem(params, fakeApi()) as CustomSeriesRenderItemReturn & {
    children?: Array<{ type: string; shape?: { x: number; y: number; width: number; height: number }; style?: { fill: string } }>;
  };
  const rect = result.children?.find((c) => c.type === 'rect');
  if (!rect?.shape) throw new Error('renderItem did not return a rect child');
  return rect.shape;
}

function rectColour(series: CustomSeries, dataIndex: number): string {
  const params = { dataIndex } as unknown as CustomSeriesRenderItemParams;
  const result = series.renderItem(params, fakeApi()) as CustomSeriesRenderItemReturn & {
    children?: Array<{ type: string; style?: { fill: string } }>;
  };
  const rect = result.children?.find((c) => c.type === 'rect');
  return rect?.style?.fill ?? '';
}

describe('waterfallOption', () => {
  it('labels the x axis with the step labels, in order', () => {
    const opt = waterfallOption(steps) as { xAxis: { data: string[] } };
    expect(opt.xAxis.data).toEqual(['Revenue', 'Cost of Sales', 'Gross Profit']);
  });

  it('is a single custom series carrying [start, end] geometry, not a stacked pair', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    expect(opt.series).toHaveLength(1);
    expect(opt.series[0]!.type).toBe('custom');
    expect(opt.series[0]!.data).toEqual([[0, 1000], [1000, 600], [0, 600]]);
  });

  it('draws each bar spanning exactly its own start-to-end pixel range', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;
    // Revenue: 0 -> 1000, entirely above the zero line.
    const revenue = renderRect(series, 0);
    expect(revenue.y).toBeCloseTo(ZERO_Y - 1000 * SCALE);
    expect(revenue.height).toBeCloseTo(1000 * SCALE);
  });

  it('paints increases favourable, decreases unfavourable, subtotals in ink', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;
    expect(rectColour(series, 0)).toBe(DEFAULT_CHART_PALETTE.fav);
    expect(rectColour(series, 1)).toBe(DEFAULT_CHART_PALETTE.unfav);
    expect(rectColour(series, 2)).toBe(DEFAULT_CHART_PALETTE.ink);
  });

  it('draws a bar that spans both sides of zero when the running total crosses it', () => {
    // Gross Profit 400,000 -> Opex takes it to a loss of 400,000 -> Net
    // Profit subtotal sits at -400,000. The old transparent-base-plus-stack
    // trick drew this entirely above the axis; it must now cross it.
    const crossing: WaterfallStep[] = [
      { label: 'Gross Profit', start: 0, end: 400_000, value: 400_000, isSubtotal: true, color: 'teal' },
      { label: 'Operating Expenses', start: 400_000, end: -400_000, value: -800_000, isSubtotal: false, color: 'red' },
      { label: 'Net Profit', start: 0, end: -400_000, value: -400_000, isSubtotal: true, color: 'blue' },
    ];
    const opt = waterfallOption(crossing) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;

    const movement = renderRect(series, 1);
    expect(movement.y).toBeLessThan(ZERO_Y);
    expect(movement.y + movement.height).toBeGreaterThan(ZERO_Y);

    // The negative subtotal sits below the zero line, not above it, and is
    // still ink — a subtotal has no variance colour of its own.
    const subtotal = renderRect(series, 2);
    expect(subtotal.y).toBeGreaterThanOrEqual(ZERO_Y);
    expect(rectColour(series, 2)).toBe(DEFAULT_CHART_PALETTE.ink);
  });

  it('prints the service figure on the bar label, never a derived height', () => {
    const opt = waterfallOption(steps) as unknown as { series: CustomSeries[] };
    const series = opt.series[0]!;
    const params = { dataIndex: 1 } as unknown as CustomSeriesRenderItemParams;
    const result = series.renderItem(params, fakeApi()) as CustomSeriesRenderItemReturn & {
      children?: Array<{ type: string; style?: { text?: string } }>;
    };
    const text = result.children?.find((c) => c.type === 'text');
    // Cost of Sales: value -400 — the signed service figure, not abs(400).
    expect(text?.style?.text).toContain('400');
    expect(text?.style?.text).toMatch(/[(−-]/); // parenthesised or minus-signed
  });

  it('escapes a hostile step label before it reaches the tooltip HTML', () => {
    const hostile: WaterfallStep[] = [
      { label: '<img src=x onerror=1>', start: 0, end: 100, value: 100, isSubtotal: false, color: 'green' },
    ];
    const opt = waterfallOption(hostile) as unknown as TooltipFormatterOption;
    const html = opt.tooltip.formatter({ dataIndex: 0 });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('trendOption', () => {
  const points = [
    { label: 'Mar 2026', value: 100 },
    { label: 'Apr 2026', value: 140 },
  ];

  it('plots the points as given, in order', () => {
    const opt = trendOption(points) as unknown as { xAxis: { data: string[] }; series: Array<{ data: number[] }> };
    expect(opt.xAxis.data).toEqual(['Mar 2026', 'Apr 2026']);
    expect(opt.series[0]!.data).toEqual([100, 140]);
  });

  it('renders without animation, so a headless screenshot is never mid-transition', () => {
    const opt = trendOption(points) as { animation: boolean };
    expect(opt.animation).toBe(false);
  });

  it('escapes a hostile point label before it reaches the tooltip HTML', () => {
    const hostile = [{ label: '<img src=x onerror=1>', value: 5 }];
    const opt = trendOption(hostile) as unknown as TooltipFormatterOption;
    const html = opt.tooltip.formatter({ dataIndex: 0 });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
