/**
 * `kpiColumnWidthsMm`: the widths of a KPI tile row's four columns as the stylesheet lays them out
 * (`minmax(auto, 1fr)` columns, figures shrunk to fit the row), which the height model reads so a
 * stretched column is charged the taller sparkline it prints. The printed proof is
 * `tests/unit/print/packNothingPassesTheEdge.test.ts` (the KPI block never taller than modelled).
 */
import { describe, expect, it } from 'vitest';
import { kpiColumnWidthsMm } from '@/modules/accounting/services/packs/pages/packKpiRowFit';
import { kpiTileHeight } from '@/modules/accounting/services/packs/pages/packKpiTileHeight';
import { PAGE_WIDTH_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import type { PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';

const tile = (value: number, withSpark = true): PackKpiTile => ({
  label: 'Net profit',
  figure: { value, format: 'money', source: 'packFigureSet.current.netProfit' },
  delta: { value: 12, unit: 'percent', basis: 'prior period', favourable: true },
  deltaAbsence: null,
  trendFootnote: null,
  sparklineSvg: withSpark ? ('<svg></svg>' as never) : null,
  sparklineWindow: null,
  sparklineScale: null,
});
const row = (...values: number[]) => values.map((v) => tile(v));
const ROOM = PAGE_WIDTH_MM.portrait - 3 * 8;

describe('kpiColumnWidthsMm', () => {
  it('shares the room between four columns: equal quarters for ordinary figures', () => {
    const widths = kpiColumnWidthsMm(row(126_000, 45, 910, 610));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(ROOM, 6);
    widths.forEach((w) => expect(w).toBeCloseTo(ROOM / 4, 6));
  });

  it('gives a column whose figure is wider than a quarter that figure\'s width, and squeezes the others', () => {
    const widths = kpiColumnWidthsMm(row(-133_500_000, 45, 910, 610));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(ROOM, 6);
    expect(widths[0]!).toBeGreaterThan(ROOM / 4);
    expect(widths[1]!).toBeLessThan(ROOM / 4);
  });

  it('assigns tile i to column i % 4 (a second row widens the same column)', () => {
    const widths = kpiColumnWidthsMm([...row(1, 2, 3, 4), ...row(1, 2, -133_500_000, 4)]);
    expect(widths[2]!).toBeGreaterThan(ROOM / 4);
  });
});

describe('kpiTileHeight in a column', () => {
  it('a stretched column draws a taller sparkline, capped at the stylesheet\'s 33mm', () => {
    const quarter = kpiTileHeight(tile(1));
    expect(kpiTileHeight(tile(1), 41)).toBeGreaterThan(quarter);
    expect(kpiTileHeight(tile(1), 60)).toBeCloseTo(kpiTileHeight(tile(1), 80), 6);
  });

  it('is never charged less than a quarter\'s sparkline in a squeezed column, and wraps its text no wider than a quarter', () => {
    expect(kpiTileHeight(tile(1), 30)).toBeGreaterThanOrEqual(kpiTileHeight(tile(1)));
  });
});
