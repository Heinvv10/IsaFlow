/**
 * The 13-week runway: closing cash per week as a line in the actual ink, the weeks below zero shaded in the
 * unfavourable ink (the one source of red), the labels "Week N · d Mon", rands on the axis. Tooltip text escaped.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import { varianceColor } from '@/components/accounting/charts/ibcs';
import { buildCash13RunwayOption, CLOSING_SERIES, BELOW_ZERO_SERIES, runwaySummary } from '@/components/accounting/cashForecast13/cash13RunwayOption';
import { forecastFixture } from './fixture';

type S = { name: string; type: string; data: Array<number | null>; itemStyle?: { color?: string } };

describe('buildCash13RunwayOption', () => {
  const f = forecastFixture();
  const opt = buildCash13RunwayOption(f.weeks, DEFAULT_PALETTE) as { series: S[]; xAxis: { data: string[] } };
  const closing = opt.series.find((s) => s.name === CLOSING_SERIES)!;
  const shade = opt.series.find((s) => s.name === BELOW_ZERO_SERIES);

  it('plots closing cash per week in rands', () => {
    expect(closing.data).toEqual(f.weeks.map((w) => w.closingCents / 100));
    expect(opt.xAxis.data[0]).toBe('Week 1 · 16 Nov');
  });

  it('shades exactly the weeks below zero, in the unfavourable ink', () => {
    expect(f.weeks.some((w) => w.closingCents < 0)).toBe(true);
    expect(shade!.data).toEqual(f.weeks.map((w) => (w.closingCents < 0 ? w.closingCents / 100 : null)));
    expect(shade!.itemStyle!.color).toBe(varianceColor(false, DEFAULT_PALETTE));
  });

  it('no shading when cash stays above zero', () => {
    const rich = forecastFixture({ openingCents: 100_000_000 });
    const o = buildCash13RunwayOption(rich.weeks, DEFAULT_PALETTE) as { series: S[] };
    expect(o.series.some((s) => s.name === BELOW_ZERO_SERIES)).toBe(false);
  });

  it('says the figures in words', () => {
    expect(runwaySummary(f.weeks)).toMatch(/^Closing cash .* in week 1 to .* in week 13; lowest .* in week \d+\.$/);
  });
});
