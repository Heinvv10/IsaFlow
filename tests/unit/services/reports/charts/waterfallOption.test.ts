import { describe, it, expect } from 'vitest';
import { buildProfitWaterfall } from '@/modules/accounting/services/reports/waterfallDataService';
import { buildWaterfallOption } from '@/components/accounting/charts/waterfallOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const STEPS = buildProfitWaterfall({
  revenue: 1_000_000,
  costOfSales: 400_000,
  grossProfit: 600_000,
  operatingExpenses: 250_000,
  otherIncome: 0,
  otherExpenses: 0,
  netProfit: 350_000,
});

type Series = { name?: string; type: string; stack?: string; data: unknown[] };
const seriesOf = (o: Record<string, unknown>) => o['series'] as Series[];
const catAxis = (o: Record<string, unknown>) => o['xAxis'] as { data: string[] };
const valAxis = (o: Record<string, unknown>) => o['yAxis'] as { min: number; max: number };

describe('buildWaterfallOption', () => {
  const opt = buildWaterfallOption(STEPS, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('draws one bar per service step, in service order', () => {
    expect(catAxis(opt).data).toEqual(STEPS.map((s) => s.label));
  });

  it('carries the service value on the bar, never a value it derived', () => {
    const bars = seriesOf(opt).find((s) => s.name === 'bar')!;
    const values = (bars.data as Array<{ value: number }>).map((d) => d.value);
    expect(values).toEqual(STEPS.map((s) => Math.abs(s.end - s.start)));
    // and the LABEL is the service figure, not the geometry
    const labels = (bars.data as Array<{ figure: number }>).map((d) => d.figure);
    expect(labels).toEqual(STEPS.map((s) => s.value));
  });

  it('offsets each movement with a transparent placeholder at min(start, end)', () => {
    const pad = seriesOf(opt).find((s) => s.name === 'placeholder')!;
    expect(pad.data).toEqual(STEPS.map((s) => Math.min(s.start, s.end)));
    expect(pad.stack).toBe(seriesOf(opt).find((s) => s.name === 'bar')!.stack);
  });

  it('never colours a bar by the step name hint', () => {
    const bars = seriesOf(opt).find((s) => s.name === 'bar')!;
    const colours = new Set(
      (bars.data as Array<{ itemStyle: { color: string } }>).map((d) => d.itemStyle.color),
    );
    expect(colours.has(DEFAULT_PALETTE.fav)).toBe(false);
    expect(colours.has(DEFAULT_PALETTE.unfav)).toBe(false);
  });

  it('anchors the value axis at zero', () => {
    expect(valAxis(opt).min).toBe(0);
  });

  it('renders an empty step list as an empty chart rather than throwing', () => {
    const empty = buildWaterfallOption([], DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect(catAxis(empty).data).toEqual([]);
  });
});
