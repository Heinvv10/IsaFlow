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

  it('colours every budgeted cell with a variance fav or unfav by its own favourable, nothing else', () => {
    // 7 budgeted cells: 5 with a variance, 2 exactly on budget (outlined, below).
    const budgeted = cells.filter((c) => c.style.decal === undefined && c.style.stroke === undefined);
    expect(budgeted.length).toBe(5);
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

  it('opacity is |v| / max|v|, never below the floor (0.25) for a nonzero variance', () => {
    const opacities = cells.filter((c) => c.style.decal === undefined && c.style.stroke === undefined).map((c) => c.style.opacity).sort();
    // |v| / max is 0.1, 0.1, 0.2, 0.2, 1: the four small ones are raised to the floor (review r2 N4).
    expect(opacities).toEqual([0.25, 0.25, 0.25, 0.25, 1].sort());
  });

  it('an on-budget month (variance 0) is an outline in the axis ink, never coloured, never invisible (review r3 L3)', () => {
    const onBudget = cells.filter((c) => c.style.stroke !== undefined && c.style.decal === undefined);
    expect(onBudget.length).toBe(2);
    for (const c of onBudget) {
      expect(c.style.stroke).toBe(PALETTE.axisLabel);
      expect([PALETTE.fav, PALETTE.unfav]).not.toContain(c.style.fill);
    }
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

describe('months not yet judged (browser review r1 L1, r2 N1)', () => {
  // Judged through June: July is in progress and August still to come. Both hold part or no actuals
  // against a whole month's budget, so neither is a variance yet.
  const option = buildVarianceHeatmapOption(LINES, MONTHS, PALETTE, { judgedThrough: '2026-06' })!;
  const cells = paint(option);
  const rowOf = (code: string) => (option as { yAxis: { data: string[] } }).yAxis.data.findIndex((r) => r.startsWith(code));
  const at = (code: string, m: number) => cells[rowOf(code) * MONTHS.length + m]!;

  it('every month after the last judged one is drawn neutral, never fav or unfav, and marked "*"', () => {
    for (const m of [1, 2]) {
      expect([PALETTE.fav, PALETTE.unfav]).not.toContain(at('6100', m).style.fill);
      expect(at('6100', m).style.fill).toBe(PALETTE.axisLine);
    }
    expect([PALETTE.fav, PALETTE.unfav]).toContain(at('6100', 0).style.fill);
    expect((option as { xAxis: { data: string[] } }).xAxis.data).toEqual(['Jun 26', 'Jul 26 *', 'Aug 26 *']);
  });

  it('they are left out of the colour scale: the largest judged variance is full strength', () => {
    // A future month with a huge "miss" (actual 0 against its budget) must not wash out June.
    const big = buildVarianceHeatmapOption(
      LINES.map((l) => (l.accountCode === '4000' ? { ...l, monthly: l.monthly.map((m, i) => (i === 2 ? { ...m, budget: 20, variance: -9000, favourable: false } : m)) } : l)),
      MONTHS, PALETTE, { judgedThrough: '2026-06' })!;
    const drawn = paint(big);
    const rows = (big as { yAxis: { data: string[] } }).yAxis.data;
    expect(drawn[rows.findIndex((r) => r.startsWith('6100')) * MONTHS.length]!.style.opacity).toBe(1);
  });

  it('they say so in the tooltip', () => {
    const fmt = (option as { tooltip: { formatter: (p: { dataIndex: number }) => string } }).tooltip.formatter;
    expect(fmt({ dataIndex: rowOf('6100') * MONTHS.length + 2 })).toContain('Not yet judged: the month is in progress or still to come');
  });
});

describe('small variances stay visible (browser review r2 N4)', () => {
  it('a nonzero variance is drawn at no less than the floor; an on-budget month (0) stays clear', () => {
    const tiny = buildVarianceHeatmapOption([
      line('6000', 'Small', [[100.5, 100, false], [100, 100, true], [0, null, null]], 1),
      line('6100', 'Large', [[10_000, 100, false], [100, 100, true], [0, null, null]], 9900),
    ], MONTHS, PALETTE)!;
    const drawn = paint(tiny);
    const rows = (tiny as { yAxis: { data: string[] } }).yAxis.data;
    const small = drawn[rows.findIndex((r) => r.startsWith('6000')) * MONTHS.length]!;
    expect(small.style.opacity).toBeGreaterThanOrEqual(0.25);
    expect(drawn[rows.findIndex((r) => r.startsWith('6000')) * MONTHS.length + 1]!.style.stroke).toBe(PALETTE.axisLabel);
  });
});
