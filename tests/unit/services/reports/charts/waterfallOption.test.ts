import { describe, it, expect } from 'vitest';
import { buildProfitWaterfall } from '@/modules/accounting/services/reports/waterfallDataService';
import { buildWaterfallOption, makeWaterfallRenderItem } from '@/components/accounting/charts/waterfallOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import { formatMoney } from '@/lib/format/money';

const STEPS = buildProfitWaterfall({
  revenue: 1_000_000,
  costOfSales: 400_000,
  grossProfit: 600_000,
  operatingExpenses: 250_000,
  otherIncome: 0,
  otherExpenses: 0,
  netProfit: 350_000,
});

// A running total that dips below zero mid-bridge (Operating Expenses takes
// Gross Profit of 400,000 down to a Net Loss of -400,000), so a movement AND
// a subtotal both cross/sit on the wrong side of the axis.
const LOSS_STEPS = buildProfitWaterfall({
  revenue: 1_000_000,
  costOfSales: 600_000,
  grossProfit: 400_000,
  operatingExpenses: 800_000,
  otherIncome: 0,
  otherExpenses: 0,
  netProfit: -400_000,
});

type Series = { name?: string; type: string; data: unknown[] };
const seriesOf = (o: Record<string, unknown>) => o['series'] as Series[];
const catAxis = (o: Record<string, unknown>) => o['xAxis'] as { data: string[] };
const valAxis = (o: Record<string, unknown>) => o['yAxis'] as { min: number; max: number };

/** A minimal `api` stand-in: `coord` maps [categoryIndex, value] straight
 * through to `[categoryIndex * 10, value]` (no pixel inversion), so a rect's
 * shape can be asserted directly against the step's own start/end. */
function fakeApi() {
  return {
    coord: (d: [number, number]) => [d[0] * 10, d[1]],
    size: () => [10, 0],
  };
}

interface RectChild {
  type: 'rect';
  shape: { x: number; y: number; width: number; height: number };
  style: { fill: string };
}
interface TextChild {
  type: 'text';
  style: { text: string };
}

function renderStep(steps: Parameters<typeof makeWaterfallRenderItem>[0], index: number) {
  const renderItem = makeWaterfallRenderItem(steps, DEFAULT_PALETTE);
  return renderItem(
    { dataIndex: index } as unknown as Parameters<typeof renderItem>[0],
    fakeApi() as unknown as Parameters<typeof renderItem>[1],
  ) as unknown as { children: [RectChild, TextChild] };
}

describe('buildWaterfallOption', () => {
  const opt = buildWaterfallOption(STEPS, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('draws one bar per service step, in service order', () => {
    expect(catAxis(opt).data).toEqual(STEPS.map((s) => s.label));
  });

  it('renders a single custom series named "bar"', () => {
    const series = seriesOf(opt);
    expect(series).toHaveLength(1);
    expect(series[0].name).toBe('bar');
    expect(series[0].type).toBe('custom');
  });

  it('carries the service value on the bar label, never a value it derived', () => {
    STEPS.forEach((s, i) => {
      const group = renderStep(STEPS, i);
      expect(group.children[1].style.text).toBe(formatMoney(s.value));
    });
  });

  it('anchors the value axis at zero when every figure is non-negative', () => {
    expect(valAxis(opt).min).toBe(0);
  });

  it('renders an empty step list as an empty chart rather than throwing', () => {
    const empty = buildWaterfallOption([], DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect(catAxis(empty).data).toEqual([]);
  });

  it('colours a cost movement unfavourable and a revenue movement favourable', () => {
    const revenue = renderStep(STEPS, 0); // Revenue: 0 -> 1,000,000 (grows profit)
    const costOfSales = renderStep(STEPS, 1); // Cost of Sales: 1,000,000 -> 600,000 (shrinks profit)
    expect(revenue.children[0].style.fill).toBe(DEFAULT_PALETTE.fav);
    expect(costOfSales.children[0].style.fill).toBe(DEFAULT_PALETTE.unfav);
  });

  it('colours a subtotal with actual ink, not a variance colour, even when it is a loss', () => {
    const netLoss = LOSS_STEPS[LOSS_STEPS.length - 1]!;
    expect(netLoss.isSubtotal).toBe(true);
    expect(netLoss.value).toBeLessThan(0);
    const group = renderStep(LOSS_STEPS, LOSS_STEPS.length - 1);
    expect(group.children[0].style.fill).toBe(DEFAULT_PALETTE.ink);
    expect(group.children[0].style.fill).not.toBe(DEFAULT_PALETTE.fav);
    expect(group.children[0].style.fill).not.toBe(DEFAULT_PALETTE.unfav);
  });

  it('draws a rect that crosses zero correctly for a movement that flips sign', () => {
    const opex = LOSS_STEPS[3]!; // Operating Expenses: 400,000 -> -400,000
    expect(opex.label).toBe('Operating Expenses');
    expect(opex.start).toBeGreaterThan(0);
    expect(opex.end).toBeLessThan(0);
    const group = renderStep(LOSS_STEPS, 3);
    // api.coord is the identity on value in this fake, so shape.y is the
    // pixel-space minimum of the two endpoints and height their distance —
    // exactly what a bar that straddles zero must have, not |end - start|
    // stacked entirely on one side of it.
    expect(group.children[0].shape.y).toBe(Math.min(opex.start, opex.end));
    expect(group.children[0].shape.height).toBe(Math.abs(opex.end - opex.start));
  });

  it('draws a negative subtotal below the axis, not above it', () => {
    const netLoss = LOSS_STEPS[LOSS_STEPS.length - 1]!;
    expect(netLoss.start).toBe(0);
    expect(netLoss.end).toBeLessThan(0);
    const group = renderStep(LOSS_STEPS, LOSS_STEPS.length - 1);
    expect(group.children[0].shape.y).toBe(netLoss.end);
    expect(group.children[0].shape.height).toBe(Math.abs(netLoss.end - netLoss.start));
  });
});
