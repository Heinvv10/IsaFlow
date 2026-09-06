import { describe, it, expect } from 'vitest';
import {
  buildCashPositionOption, type CashPositionPoint,
} from '@/components/accounting/charts/cashPositionOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const POINTS: CashPositionPoint[] = [
  { name: 'Cash', value: 480_000 },
  { name: 'AR', value: 1_250_000 },
  { name: 'AP', value: 690_000 },
  { name: 'NWC', value: 1_040_000 },
];

const asRec = (o: unknown) => o as Record<string, unknown>;

describe('buildCashPositionOption', () => {
  const opt = asRec(buildCashPositionOption(POINTS, DEFAULT_PALETTE));

  it('plots the values it was given, in order', () => {
    expect((opt['series'] as Array<{ data: Array<{ value: number }> }>)[0]!.data.map((d) => d.value))
      .toEqual(POINTS.map((p) => p.value));
    expect((opt['xAxis'] as { data: string[] }).data).toEqual(['Cash', 'AR', 'AP', 'NWC']);
  });

  const inks = (o: Record<string, unknown>) =>
    (o['series'] as Array<{ data: Array<{ itemStyle: { color: string } }> }>)[0]!
      .data.map((d) => d.itemStyle.color);

  it('draws every non-negative bar in actual ink, emphasising no category', () => {
    expect(inks(opt)).toEqual(Array(POINTS.length).fill(DEFAULT_PALETTE.ink));
  });

  it('marks a bar below zero unfavourable, so an overdraft is not invisible', () => {
    // The two readings on this chart a reader must not miss are an overdrawn
    // bank balance and negative working capital. In one ink they pointed down
    // and said nothing else.
    const mixed = asRec(buildCashPositionOption([
      { name: 'Cash', value: -120_000 },
      { name: 'AR', value: 1_250_000 },
      { name: 'NWC', value: -300_000 },
    ], DEFAULT_PALETTE));
    expect(inks(mixed)).toEqual([
      DEFAULT_PALETTE.unfav, DEFAULT_PALETTE.ink, DEFAULT_PALETTE.unfav,
    ]);
  });

  it('never paints a positive bar favourable, because these are measures not variances', () => {
    // A large payables balance is a normal liability. Green on it would claim
    // good news the figure does not carry.
    const ap = asRec(buildCashPositionOption([{ name: 'AP', value: 690_000 }], DEFAULT_PALETTE));
    expect(inks(ap)).toEqual([DEFAULT_PALETTE.ink]);
    expect(inks(ap)).not.toContain(DEFAULT_PALETTE.fav);
  });

  it('anchors the axis at zero', () => {
    expect((opt['yAxis'] as { min: number }).min).toBe(0);
  });

  it('spans below zero when working capital is negative', () => {
    const neg = asRec(buildCashPositionOption([{ name: 'NWC', value: -300_000 }], DEFAULT_PALETTE));
    expect((neg['yAxis'] as { min: number }).min).toBeLessThan(-300_000);
  });

  it('labels the axis in full rand, never in an unstated K scale', () => {
    const fmt = (opt['yAxis'] as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter;
    expect(fmt(1_250_000)).not.toMatch(/K/);
    expect(fmt(1_250_000)).toContain('250');
  });

  it('escapes a point name before it reaches the tooltip HTML', () => {
    type TooltipOption = { tooltip: { formatter: (p: Array<{ name: string; value: number }>) => string } };
    const malicious: CashPositionPoint[] = [{ name: '<img src=x onerror=1>', value: 480_000 }];
    const withXss = asRec(buildCashPositionOption(malicious, DEFAULT_PALETTE)) as unknown as TooltipOption;
    const html = withXss.tooltip.formatter([{ name: malicious[0]!.name, value: malicious[0]!.value }]);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x onerror=1>');
  });
});
