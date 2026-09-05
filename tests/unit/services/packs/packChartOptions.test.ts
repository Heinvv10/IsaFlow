import { describe, it, expect } from 'vitest';
import { waterfallOption, trendOption, DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const steps: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 1000, value: 1000, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: 1000, end: 600, value: -400, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: 600, value: 600, isSubtotal: true, color: 'teal' },
];

interface BarSeries { name: string; type: string; stack: string; data: Array<number | { value: number; itemStyle: { color: string } }> }
interface TooltipFormatterOption {
  tooltip: { formatter: (params: { dataIndex: number } | Array<{ dataIndex: number }>) => string };
}

describe('waterfallOption', () => {
  it('labels the x axis with the step labels, in order', () => {
    const opt = waterfallOption(steps) as { xAxis: { data: string[] } };
    expect(opt.xAxis.data).toEqual(['Revenue', 'Cost of Sales', 'Gross Profit']);
  });

  it('floats each bar on an invisible base at the lower of start and end', () => {
    const opt = waterfallOption(steps) as unknown as { series: BarSeries[] };
    expect(opt.series[0]!.data).toEqual([0, 600, 0]);
  });

  it('draws the visible bar at the absolute movement', () => {
    const opt = waterfallOption(steps) as unknown as { series: BarSeries[] };
    const values = opt.series[1]!.data.map((d) => (typeof d === 'number' ? d : d.value));
    expect(values).toEqual([1000, 400, 600]);
  });

  it('paints increases favourable, decreases unfavourable, subtotals in ink', () => {
    const opt = waterfallOption(steps) as unknown as { series: BarSeries[] };
    const colours = opt.series[1]!.data.map((d) => (typeof d === 'number' ? '' : d.itemStyle.color));
    expect(colours).toEqual([DEFAULT_CHART_PALETTE.fav, DEFAULT_CHART_PALETTE.unfav, DEFAULT_CHART_PALETTE.ink]);
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
