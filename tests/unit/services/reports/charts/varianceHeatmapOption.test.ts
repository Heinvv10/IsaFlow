/**
 * Budgets P3 §2.7: the account x month variance heatmap. Every cell is
 * coloured by `varianceColor` alone (no visualMap ramp, which would issue
 * green and red outside it), at an opacity proportional to |v| / max|v|; a
 * month with no budget is hatched with the forecast decal and not coloured;
 * a ledger name reaches the tooltip escaped; rows are the top 15 accounts by
 * |window variance| unless "show all".
 */
import { describe, expect, it } from 'vitest';
import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts';
import { buildVarianceHeatmapOption, heatmapAccounts } from '@/components/accounting/charts/varianceHeatmapOption';
import { roleStyle } from '@/components/accounting/charts/ibcs';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import type { TrackingLine, TrackingMonth } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

// Distinct from every literal a builder might hard-code.
const PALETTE: ChartPalette = { ...DEFAULT_PALETTE, fav: '#00aa01', unfav: '#bb0002', plan: '#777703' };
const MONTHS = ['2026-06', '2026-07', '2026-08'];

function line(code: string, name: string, monthly: Array<[number, number | null, boolean | null]>, variance: number | null): TrackingLine {
  const months: TrackingMonth[] = monthly.map(([actual, budget, favourable], i) => ({
    month: MONTHS[i]!, actual, budget, variance: budget === null ? null : Math.round((actual - budget) * 100) / 100, favourable, budgetAboveFilter: false,
  }));
  return {
    accountId: `id-${code}`, accountCode: code, accountName: name, accountType: 'expense', band: 'operating_expense',
    actual: 0, budget: variance === null ? null : 0, variance, variancePct: null, favourable: null,
    projected: 0, fyBudget: null, projVariance: null, projFavourable: null, unallocatedBudget: 0, budgetAboveFilter: false, monthly: months,
  };
}

const EVIL = '<img src=x onerror=1>';
const LINES: TrackingLine[] = [
  line('6000', EVIL, [[120, 100, false], [80, 100, true], [50, null, null]], 50),
  line('6100', 'Wages', [[400, 300, false], [300, 300, true], [300, 300, true]], 100),
  line('4000', 'Sales', [[10, 20, false], [30, 20, true], [0, null, null]], -10),
];

interface Drawn { style: { fill?: string; opacity?: number; decal?: unknown; stroke?: string } }
function paint(option: ReturnType<typeof buildVarianceHeatmapOption>) {
  const series = (option as { series: Array<{ renderItem: (p: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => Drawn; data: number[][] }> }).series[0]!;
  const api = { coord: ([x, y]: number[]) => [x! * 10, y! * 10], size: () => [10, 10], value: (i: number) => i } as unknown as CustomSeriesRenderItemAPI;
  return series.data.map((_, i) => series.renderItem({ dataIndex: i } as CustomSeriesRenderItemParams, api));
}

describe('buildVarianceHeatmapOption', () => {
  const option = buildVarianceHeatmapOption(LINES, MONTHS, PALETTE)!;
  const cells = paint(option);

  it('draws one cell per account and month, without a visualMap', () => {
    expect(cells.length).toBe(LINES.length * MONTHS.length);
    expect((option as Record<string, unknown>).visualMap).toBeUndefined();
  });

  it('colours every budgeted cell fav or unfav by its own favourable, nothing else', () => {
    const budgeted = cells.filter((c) => c.style.decal === undefined);
    expect(budgeted.length).toBe(7);
    for (const c of budgeted) expect([PALETTE.fav, PALETTE.unfav]).toContain(c.style.fill);
    // Wages, June: actual 400 vs 300 on an expense = unfavourable.
    const wages = LINES.findIndex((l) => l.accountCode === '6100');
    const rows = (option as { yAxis: { data: string[] } }).yAxis.data;
    const row = rows.findIndex((r) => r.startsWith('6100'));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(wages).toBeGreaterThanOrEqual(0);
    const data = (option as { series: Array<{ data: number[][] }> }).series[0]!.data;
    const at = data.findIndex(([x, y]) => x === 0 && y === row);
    expect(cells[at]!.style.fill).toBe(PALETTE.unfav);
    expect(cells[at]!.style.opacity).toBe(1);
  });

  it('opacity is |v| / max|v|', () => {
    const opacities = cells.filter((c) => c.style.decal === undefined).map((c) => c.style.opacity).sort();
    expect(opacities).toEqual([0, 0, 0.1, 0.1, 0.2, 0.2, 1].sort());
  });

  it("hatches a month with no budget with the forecast decal, uncoloured", () => {
    const hatched = cells.filter((c) => c.style.decal !== undefined);
    expect(hatched.length).toBe(2);
    const forecast = roleStyle('forecast', PALETTE);
    for (const c of hatched) {
      expect(c.style.decal).toEqual(forecast.decal);
      expect([PALETTE.fav, PALETTE.unfav]).not.toContain(c.style.fill);
    }
  });

  it('escapes a ledger name in the tooltip', () => {
    const fmt = (option as { tooltip: { formatter: (p: { dataIndex: number }) => string } }).tooltip.formatter;
    const all = cells.map((_, i) => fmt({ dataIndex: i })).join('\n');
    expect(all).not.toContain('<img');
    expect(all).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('ranks the top 15 by |window variance|, the largest at the top; show all lifts the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => line(String(5000 + i), `A${i}`, [[i, 0, false], [0, 0, true], [0, 0, true]], i));
    many.push(line('9999', 'Unbudgeted', [[5, null, null], [0, null, null], [0, null, null]], null));
    expect(heatmapAccounts(many).map((l) => l.accountCode)).toEqual(Array.from({ length: 15 }, (_, i) => String(5019 - i)));
    expect(heatmapAccounts(many, { showAll: true }).length).toBe(21);
    expect(heatmapAccounts(many, { showAll: true }).at(-1)!.accountCode).toBe('9999');
    const rows = (buildVarianceHeatmapOption(many, MONTHS, PALETTE) as { yAxis: { data: string[] } }).yAxis.data;
    // ECharts draws category index 0 at the bottom: the largest is LAST.
    expect(rows.at(-1)).toBe('5019 A19');
  });

  it('R4: the tooltip tells a month budgeted above the filter from a month with no budget', () => {
    const above = line('7000', 'Above', [[10, null, null], [20, null, null], [30, 25, false]], 5);
    above.monthly[0]!.budgetAboveFilter = true;
    const opt = buildVarianceHeatmapOption([above], MONTHS, PALETTE)!;
    const fmt = (opt as { tooltip: { formatter: (p: { dataIndex: number }) => string } }).tooltip.formatter;
    const data = (opt as { series: Array<{ data: number[][] }> }).series[0]!.data;
    const tip = (month: number) => fmt({ dataIndex: data.findIndex(([x]) => x === month) });
    expect(tip(0)).toContain('Budgeted above this filter');
    expect(tip(0)).not.toContain('No budget for this month');
    expect(tip(1)).toContain('No budget for this month');
    expect(tip(2)).toContain('Budget');
  });

  it('nothing to draw is null', () => {
    expect(buildVarianceHeatmapOption([], MONTHS, PALETTE)).toBeNull();
  });
});

describe('the in-progress month (browser review r1 L1)', () => {
  // August is in progress: its part-month actual against a whole month's budget is not a variance yet.
  const option = buildVarianceHeatmapOption(LINES, MONTHS, PALETTE, { inProgressMonth: '2026-08' })!;
  const cells = paint(option);
  const at = (code: string, m: number) => cells[rowOf(code) * MONTHS.length + m]!;
  function rowOf(code: string) {
    const rows = (option as { yAxis: { data: string[] } }).yAxis.data;
    return rows.findIndex((r) => r.startsWith(code));
  }

  it('is drawn neutral, never fav or unfav, and labelled on the axis', () => {
    const aug = at('6100', 2);
    expect([PALETTE.fav, PALETTE.unfav]).not.toContain(aug.style.fill);
    expect(aug.style.fill).toBe(PALETTE.axisLine);
    expect((option as { xAxis: { data: string[] } }).xAxis.data).toEqual(['Jun 26', 'Jul 26', 'Aug 26 *']);
  });

  it('is left out of the colour scale: the largest complete-month variance is full strength', () => {
    // Without August, the largest |variance| is Wages' June 100 (August's 0 vs a part month never counts).
    const big = buildVarianceHeatmapOption(
      LINES.map((l) => (l.accountCode === '4000' ? { ...l, monthly: l.monthly.map((m, i) => (i === 2 ? { ...m, budget: 20, variance: 900, favourable: false } : m)) } : l)),
      MONTHS, PALETTE, { inProgressMonth: '2026-08' })!;
    const drawn = paint(big);
    const rows = (big as { yAxis: { data: string[] } }).yAxis.data;
    const june = drawn[rows.findIndex((r) => r.startsWith('6100')) * MONTHS.length]!;
    expect(june.style.opacity).toBe(1);
  });

  it('says so in its tooltip', () => {
    const fmt = (option as { tooltip: { formatter: (p: { dataIndex: number }) => string } }).tooltip.formatter;
    expect(fmt({ dataIndex: rowOf('6100') * MONTHS.length + 2 })).toContain('In progress: actuals to date against the whole month');
  });
});
