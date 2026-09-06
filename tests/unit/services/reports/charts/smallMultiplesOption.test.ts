import { describe, it, expect } from 'vitest';
import {
  buildSmallMultiplesOption, type TrendPanel,
} from '@/components/accounting/charts/smallMultiplesOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const MONTHS = ['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
const PANELS: TrendPanel[] = [
  { key: '1000', label: 'Sales', values: [100, 120, 90, 140, 130, 150, 160, 155, 170, 165, 180, 175].map(v => v * 1000) },
  { key: '6000', label: 'Rent', values: Array(12).fill(12000) },
];

const asRec = (o: unknown) => o as Record<string, unknown>;

describe('buildSmallMultiplesOption', () => {
  const opt = asRec(buildSmallMultiplesOption(PANELS, MONTHS, DEFAULT_PALETTE, { columns: 2 }));

  it('builds one grid, one x axis, one y axis and one series per panel', () => {
    for (const key of ['grid', 'xAxis', 'yAxis', 'series']) {
      expect((opt[key] as unknown[]).length).toBe(PANELS.length);
    }
  });

  it('gives every panel the SAME explicit scale', () => {
    const axes = opt['yAxis'] as Array<{ min: number; max: number }>;
    const first = axes[0]!;
    for (const a of axes) {
      expect(a.min).toBe(first.min);
      expect(a.max).toBe(first.max);
    }
    expect(Number.isFinite(first.min)).toBe(true);
    expect(Number.isFinite(first.max)).toBe(true);
  });

  it('never truncates: the shared scale contains zero', () => {
    expect((opt['yAxis'] as Array<{ min: number }>)[0]!.min).toBe(0);
  });

  it('plots the service values unchanged, in month order', () => {
    const series = opt['series'] as Array<{ data: number[] }>;
    expect(series[0]!.data).toEqual(PANELS[0]!.values);
    expect(series[1]!.data).toEqual(PANELS[1]!.values);
  });

  it('labels every panel with its account and every x axis with the same months', () => {
    const titles = (opt['title'] as Array<{ text: string }>).map((t) => t.text);
    expect(titles).toEqual(['Sales', 'Rent']);
    for (const x of opt['xAxis'] as Array<{ data: string[] }>) {
      expect(x.data).toEqual(MONTHS);
    }
  });

  it('draws every line in actual ink, never in the variance colours', () => {
    const json = JSON.stringify(opt);
    expect(json).not.toContain(DEFAULT_PALETTE.fav);
    expect(json).not.toContain(DEFAULT_PALETTE.unfav);
  });

  it('returns an option with no panels for an empty input rather than throwing', () => {
    const empty = asRec(buildSmallMultiplesOption([], MONTHS, DEFAULT_PALETTE));
    expect((empty['series'] as unknown[]).length).toBe(0);
  });

  it('escapes a hostile account label before it reaches the tooltip formatter', () => {
    const hostile: TrendPanel[] = [
      { key: '9999', label: '<img src=x onerror=1>', values: Array(12).fill(500) },
    ];
    const hostileOpt = asRec(buildSmallMultiplesOption(hostile, MONTHS, DEFAULT_PALETTE));
    const tooltip = hostileOpt['tooltip'] as { formatter: (p: Array<{ name: string; value: number; seriesName: string }>) => string };
    const out = tooltip.formatter([{ name: MONTHS[0]!, value: 500, seriesName: '<img src=x onerror=1>' }]);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});
