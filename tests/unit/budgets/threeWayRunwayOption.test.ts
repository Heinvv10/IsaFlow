/**
 * The runway chart's option (budgets P6 spec §8, §13.15): closing cash per month, the minimum-cash line,
 * months below zero shaded in the unfavourable ink (only `varianceColor` issues it), up to three compare
 * versions overlaid, and every name in a tooltip escaped (a version is user-named).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import { buildRunwayOption, type RunwaySeries } from '@/components/accounting/budgets/threeWay/runwayOption';

type Opt = { series: Array<{ name: string; type: string; data: unknown[]; itemStyle?: { color?: string } }>; xAxis: { data: string[] };
  tooltip: { formatter: (p: Array<{ seriesName: string; axisValue: string; value: number | null }>) => string } };

const months = ['2026-03', '2026-04', '2026-05'];
const base: RunwaySeries = { name: 'Base', cents: [100_00, -50_00, 20_00] };

describe('buildRunwayOption', () => {
  it('one cash line in rands, the minimum-cash line, and a shaded bar only on negative months', () => {
    const o = buildRunwayOption({ months, series: [base], minimumCashCents: 10_00 }, DEFAULT_PALETTE) as unknown as Opt;
    expect(o.xAxis.data).toEqual(months);
    const cash = o.series.find((s) => s.name === 'Base')!;
    expect(cash.type).toBe('line');
    expect(cash.data).toEqual([100, -50, 20]);
    const min = o.series.find((s) => s.name === 'Minimum cash')!;
    expect(min.data).toEqual([10, 10, 10]);
    const shade = o.series.find((s) => s.name === 'Below zero')!;
    expect(shade.type).toBe('bar');
    expect(shade.data).toEqual([null, -50, null]);
    expect(shade.itemStyle?.color).toBe(DEFAULT_PALETTE.unfav);
  });

  it('no negative month: no shading series at all', () => {
    const o = buildRunwayOption({ months, series: [{ name: 'Up', cents: [1, 2, 3] }], minimumCashCents: 0 }, DEFAULT_PALETTE) as unknown as Opt;
    expect(o.series.some((s) => s.name === 'Below zero')).toBe(false);
  });

  it('compare overlays: one line per version, at most three', () => {
    const four = ['A', 'B', 'C', 'D'].map((name) => ({ name, cents: [1, 2, 3] }));
    const o = buildRunwayOption({ months, series: four, minimumCashCents: 0 }, DEFAULT_PALETTE) as unknown as Opt;
    expect(o.series.filter((s) => s.type === 'line' && s.name !== 'Minimum cash').map((s) => s.name)).toEqual(['A', 'B', 'C']);
  });

  it('the tooltip escapes version names', () => {
    const o = buildRunwayOption({ months, series: [{ name: '<img src=x onerror=alert(1)>', cents: [1, 2, 3] }], minimumCashCents: 0 }, DEFAULT_PALETTE) as unknown as Opt;
    const html = o.tooltip.formatter([{ seriesName: '<img src=x onerror=alert(1)>', axisValue: '2026-03', value: 1 }]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
